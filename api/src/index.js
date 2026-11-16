// 活動布告欄後端（取代 gas/Code.gs）。對外的 GET／POST 格式跟 GAS 版完全一樣，前端只換網址。
// 所有讀寫都進同一個 Durable Object：它一次只處理一個請求，等於 GAS 的 Script Lock，
// 而且 SQLite 是同步呼叫，不會像 Apps Script 那樣排隊幾十秒。
import { DurableObject } from "cloudflare:workers";

const CONFIG = {
  MAX_EVENT_HISTORY: 50,
  MAX_COMMENT_LENGTH: 150,
  EVENT_DURATION_MS: 2 * 60 * 60 * 1000,
  EXPIRED_EVENT_RETENTION_MS: 24 * 60 * 60 * 1000,
  WISH_LIFESPAN_DAYS: 3,
  WISH_MIN_ATTENDEES: 3,
  MAX_HIGHLIGHTED_EVENTS: 3,
  MAX_MEMBERS: 500,
  MAX_MEMBER_NAME_LENGTH: 40,
  SCHEMA_VERSION: "5",
  TZ_OFFSET_MS: 8 * 60 * 60 * 1000 // 台北沒有日光節約，固定 UTC+8
};

const CORS = { "Access-Control-Allow-Origin": "*" };
const json = data => new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const errorOutput = error => json({ status: "error", message: error && error.message ? error.message : String(error) });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
    }
    try {
      // 學員範本：網站與後端是同一個 Worker，網頁用這支取得自己的設定，不必改任何程式。
      // LIFF_ID 是 Cloudflare 後台的變數；還沒填時網頁會顯示設定指引。
      if (new URL(request.url).pathname === "/config.js") {
        const liffId = String(env.LIFF_ID || "").trim();
        const setup = {
          GAS_API_URL: new URL("/api", request.url).toString(),
          LIFF_ID: liffId,
          LIFF_URL: liffId ? "https://liff.line.me/" + liffId : "",
          SETUP_MISSING: !liffId || !env.ADMIN_PASSWORD
        };
        return new Response("window.SITE_SETUP = " + JSON.stringify(setup) + ";",
          { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (request.method === "GET") return board(env).fetch("https://board/read");
      if (request.method !== "POST") return errorOutput(new Error("不支援的請求"));

      const payload = JSON.parse(await request.text());
      if (!payload || typeof payload !== "object") throw new Error("POST 資料格式錯誤。");

      // 這兩個不碰資料，不必進 Durable Object 排隊
      if (payload.action === "verifyAdminPassword") {
        return json({
          status: "success",
          canDeleteAnyEvent: verifyAdminPassword(env, payload.adminPassword),
          isAdminPasswordConfigured: Boolean(env.ADMIN_PASSWORD),
          serverTime: new Date().toISOString()
        });
      }
      if (payload.action === "resolveMapLocation") {
        return json({ status: "success", serverTime: new Date().toISOString(), ...(await resolveMapLocation(payload.location)) });
      }
      return board(env).fetch("https://board/write", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      return errorOutput(error);
    }
  },

  // 每天台北 00:05：許願結算、搬走過期活動（取代 GAS 的兩個觸發器）
  async scheduled(controller, env) {
    await board(env).fetch("https://board/daily", { method: "POST" });
  }
};

function board(env) {
  return env.BOARD.get(env.BOARD.idFromName("main"));
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive (id TEXT, archivedAt TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (userId TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        mutationId TEXT, logId TEXT, eventId TEXT, timestamp TEXT, actorUserId TEXT,
        actorName TEXT, actionType TEXT, action TEXT, details TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_mutation ON audit (mutationId);
    `);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/read") return json(this.publicPayload());
      if (path === "/daily") return json(this.daily());
      return json(this.write(await request.json()));
    } catch (error) {
      return errorOutput(error);
    }
  }

  // ---------- 資料存取 ----------
  allEvents() {
    return this.sql.exec("SELECT data FROM events ORDER BY rowid").toArray().map(row => JSON.parse(row.data));
  }
  getEvent(id) {
    const row = this.sql.exec("SELECT data FROM events WHERE id = ?", String(id)).toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  requireEvent(id) {
    const eventItem = this.getEvent(id);
    if (!eventItem) throw new Error("找不到活動：" + id);
    return eventItem;
  }
  putEvent(eventItem) {
    this.sql.exec("INSERT INTO events (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      eventItem.id, JSON.stringify(eventItem));
  }
  allMembers() {
    return this.sql.exec("SELECT data FROM members ORDER BY rowid").toArray().map(row => JSON.parse(row.data));
  }
  getMember(userId) {
    const row = this.sql.exec("SELECT data FROM members WHERE userId = ?", String(userId)).toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  putMember(member) {
    this.sql.exec("INSERT INTO members (userId, data) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET data = excluded.data",
      member.userId, JSON.stringify(member));
  }
  appendAudit(payload, logData) {
    this.sql.exec("INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      String(payload.mutationId || ""),
      "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      String(logData.eventId || ""),
      new Date().toISOString(),
      String(payload.actorUserId || payload.userId || ""),
      String(payload.actorName || payload.displayName || ""),
      String(logData.actionType || "activity"),
      String(logData.action || ""),
      JSON.stringify(logData.details || {}));
  }
  hasProcessedMutation(mutationId) {
    return this.sql.exec("SELECT 1 FROM audit WHERE mutationId = ? LIMIT 1", String(mutationId)).toArray().length > 0;
  }

  publicPayload() {
    return {
      status: "success",
      schemaVersion: CONFIG.SCHEMA_VERSION,
      serverTime: new Date().toISOString(),
      events: this.allEvents().filter(eventItem => !isRetiredEvent(eventItem)),
      members: this.allMembers()
    };
  }

  write(payload) {
    if (payload.action === "importSnapshot") return this.importSnapshot(payload);
    if (payload.mutationId && this.hasProcessedMutation(payload.mutationId)) {
      return { status: "success", duplicate: true, mutationId: payload.mutationId };
    }
    const handlers = {
      saveEvent: this.saveEvent,
      toggleRSVP: this.updateRsvp,
      deleteEvent: this.softDeleteEvent,
      adminRemoveAttendee: this.adminRemoveAttendee,
      addComment: this.addComment,
      toggleHighlight: this.toggleHighlight,
      adminResetInterests: this.adminResetInterests,
      checkIn: this.checkIn,
      adminSetCheckIn: this.adminSetCheckIn,
      adminRemoveMember: this.adminRemoveMember,
      adminResetCheckIns: this.adminResetCheckIns
    };
    const handler = handlers[payload.action];
    if (!handler) throw new Error("不支援的 action：" + String(payload.action || "空白"));
    // transactionSync：中途丟錯就整筆還原，不會只寫一半
    const result = this.ctx.storage.transactionSync(() => handler.call(this, payload));
    return { status: "success", mutationId: payload.mutationId || "", serverTime: new Date().toISOString(), ...result };
  }

  // 搬家用：把 GAS 版 GET 拿到的活動與名單一次匯入。只在全空時可用，避免蓋掉正式資料。
  // 用一次性的 IMPORT_SECRET，搬完就從 Cloudflare 刪掉，之後這個 action 永遠失敗。
  importSnapshot(payload) {
    if (!this.env.IMPORT_SECRET || !safeEquals(payload.importSecret, this.env.IMPORT_SECRET)) throw new Error("沒有匯入權限。");
    const hasData = this.sql.exec("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM members) AS n").one().n;
    if (hasData > 0) throw new Error("已經有資料，不能再匯入。");
    this.ctx.storage.transactionSync(() => {
      (payload.events || []).forEach(eventItem => this.putEvent(normalizeStoredEvent(eventItem)));
      (payload.members || []).forEach(member => member && member.userId && this.putMember(member));
    });
    return { status: "success", events: (payload.events || []).length, members: (payload.members || []).length };
  }

  // ---------- 活動 ----------
  saveEvent(payload) {
    const eventId = requireText(payload.id, "缺少活動 id");
    const existingEvent = this.getEvent(eventId);
    const actorUserId = String(payload.actorUserId || "");
    const eventAction = String(payload.eventAction || (existingEvent ? "update" : "create"));

    if (existingEvent) {
      assertActiveEvent(existingEvent);
      assertEditPermission(this.env, existingEvent, payload);
    } else {
      const creatingHostId = getHostUserId(payload);
      if (!actorUserId || !creatingHostId || actorUserId !== creatingHostId) {
        throw new Error("建立活動者必須與主揪相同。");
      }
    }

    const nowIso = new Date().toISOString();
    const normalizedEvent = normalizeEvent(payload, existingEvent);

    if (existingEvent) {
      // 名單永遠以後端為準，避免舊分頁覆蓋新報名；推廣只能走 toggleHighlight。
      normalizedEvent.isFixedGroup = existingEvent.isFixedGroup === true;
      normalizedEvent.isHighlighted = existingEvent.isHighlighted === true;
      normalizedEvent.attendees = normalizeUsers(existingEvent.attendees);
      normalizedEvent.history = mergeHistoryLists(existingEvent.history, payload.history);

      if (eventAction === "handoff") {
        assertHandoffPermission(this.env, existingEvent, payload);
        const newHostUserId = getHostUserId(normalizedEvent);
        const isRegistered = normalizedEvent.attendees.some(user => String(user.userId) === String(newHostUserId));
        if (!newHostUserId || newHostUserId === getHostUserId(existingEvent) || !isRegistered) {
          throw new Error("新主揪必須是另一位已報名成員。");
        }
      } else {
        // 一般編輯不可順便改主揪；交棒必須走 handoff。
        normalizedEvent.hostUser = existingEvent.hostUser;
        normalizedEvent.hostName = existingEvent.hostName;
      }
    } else {
      normalizedEvent.isHighlighted = false;
      normalizedEvent.attendees = normalizeUsers([normalizeUser(normalizedEvent.hostUser)].concat(normalizedEvent.attendees || []));
    }

    Object.assign(normalizedEvent, {
      id: eventId,
      status: "active",
      deleted: false,
      createdAt: existingEvent && existingEvent.createdAt ? existingEvent.createdAt : String(payload.createdAt || nowIso),
      updatedAt: nowIso,
      deletedAt: "",
      deletedBy: "",
      deletedByUserId: "",
      schemaVersion: CONFIG.SCHEMA_VERSION
    });

    this.putEvent(normalizedEvent);
    this.appendAudit(payload, {
      eventId,
      actionType: eventAction,
      action: getLatestHistoryAction(normalizedEvent) || (existingEvent ? "更新活動" : "建立活動"),
      details: { eventAction, changedFields: getChangedFields(existingEvent, normalizedEvent) }
    });
    return { event: normalizedEvent };
  }

  updateRsvp(payload) {
    const eventId = requireText(payload.eventId, "缺少 eventId");
    const userId = requireText(payload.userId, "缺少 userId");
    const actorUserId = String(payload.actorUserId || "");
    if (actorUserId && actorUserId !== userId) throw new Error("只能替自己報名或退出活動。");
    const eventItem = this.requireEvent(eventId);
    assertActiveEvent(eventItem);

    const attendees = normalizeUsers(eventItem.attendees);
    const existingIndex = attendees.findIndex(user => String(user.userId) === userId);
    const intent = ["join", "cancel"].includes(String(payload.rsvpAction))
      ? String(payload.rsvpAction)
      : (existingIndex >= 0 ? "cancel" : "join");

    if (intent === "cancel") {
      // 興趣調查只是表態，發起人也能取消；一般活動的主揪要先交棒。
      if (eventItem.isFixedGroup !== true && String(getHostUserId(eventItem)) === userId) {
        throw new Error("主揪必須先交棒，才能退出活動。");
      }
      if (existingIndex >= 0) attendees.splice(existingIndex, 1);
    } else if (existingIndex < 0) {
      const maxAttendees = Number(eventItem.maxAttendees || 0);
      if (maxAttendees > 0 && attendees.length >= maxAttendees) throw new Error("活動人數已滿。");
      attendees.push(normalizeUser({ userId, displayName: payload.displayName, pictureUrl: payload.pictureUrl }));
    }

    eventItem.attendees = normalizeUsers(attendees);
    eventItem.history = mergeHistoryEntries(eventItem.history, payload.historyEntry);
    eventItem.updatedAt = new Date().toISOString();
    eventItem.schemaVersion = CONFIG.SCHEMA_VERSION;
    this.putEvent(eventItem);

    this.appendAudit(payload, {
      eventId,
      actionType: intent === "join" ? "join" : "leave",
      action: intent === "join" ? "報名參加活動" : "退出活動",
      details: {
        attendeeUserId: userId,
        attendeeName: String(payload.displayName || payload.actorName || ""),
        attendeeCount: eventItem.attendees.length
      }
    });
    return { eventId, rsvpAction: intent, attendees: eventItem.attendees, history: eventItem.history };
  }

  // 留言內容由後端重新組裝，不採用前端送來的 action，避免冒充系統紀錄。
  addComment(payload) {
    const eventId = requireText(payload.eventId, "缺少 eventId");
    const userId = requireText(payload.userId, "缺少 userId");
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("留言內容不可空白。");
    if (text.length > CONFIG.MAX_COMMENT_LENGTH) throw new Error("留言請控制在 " + CONFIG.MAX_COMMENT_LENGTH + " 字以內。");

    const eventItem = this.requireEvent(eventId);
    assertActiveEvent(eventItem);
    const sourceEntry = payload.historyEntry || {};
    const entry = {
      id: String(sourceEntry.id || newLogId()),
      author: String(payload.displayName || payload.actorName || "未命名成員"),
      authorUserId: userId,
      time: String(sourceEntry.time || ""),
      timestamp: new Date().toISOString(),
      action: text,
      type: "comment"
    };
    eventItem.history = mergeHistoryEntries(eventItem.history, entry);
    eventItem.updatedAt = new Date().toISOString();
    eventItem.schemaVersion = CONFIG.SCHEMA_VERSION;
    this.putEvent(eventItem);

    this.appendAudit(payload, { eventId, actionType: "comment", action: "留言：" + text, details: { commentLength: text.length } });
    return { eventId, history: eventItem.history, entry };
  }

  toggleHighlight(payload) {
    const eventId = requireText(payload.eventId, "缺少 eventId");
    const events = this.allEvents();
    const eventItem = events.find(item => String(item.id || "") === eventId);
    if (!eventItem) throw new Error("找不到活動：" + eventId);
    assertActiveEvent(eventItem);
    assertEditPermission(this.env, eventItem, payload);

    const highlighted = isTrue(payload.highlighted);
    const wasHighlighted = eventItem.isHighlighted === true;
    if (highlighted && !wasHighlighted) {
      const count = events.filter(item =>
        String(item.id || "") !== eventId && item.isHighlighted === true && !isDeletedEvent(item) && !isEventEnded(item)
      ).length;
      if (count >= CONFIG.MAX_HIGHLIGHTED_EVENTS) throw new Error("目前已有 3 個活動正在加強推廣，請先取消其中一個再試。");
    }
    if (highlighted === wasHighlighted) return { eventId, highlighted, unchanged: true, history: eventItem.history };

    const sourceEntry = payload.historyEntry || {};
    const actionText = highlighted ? "開啟加強推廣" : "取消加強推廣";
    const entry = {
      id: String(sourceEntry.id || newLogId()),
      author: String(payload.actorName || "未命名成員"),
      authorUserId: String(payload.actorUserId || ""),
      time: String(sourceEntry.time || ""),
      timestamp: new Date().toISOString(),
      action: actionText,
      type: highlighted ? "highlight" : "unhighlight"
    };
    eventItem.isHighlighted = highlighted;
    eventItem.history = mergeHistoryEntries(eventItem.history, entry);
    eventItem.updatedAt = new Date().toISOString();
    eventItem.schemaVersion = CONFIG.SCHEMA_VERSION;
    this.putEvent(eventItem);

    this.appendAudit(payload, { eventId, actionType: highlighted ? "highlight" : "unhighlight", action: actionText, details: { highlighted } });
    return { eventId, highlighted, history: eventItem.history, entry };
  }

  // 管理員清空所有興趣標籤的人數，標籤本身保留。
  adminResetInterests(payload) {
    assertAdminPermission(this.env, payload);
    const now = new Date().toISOString();
    let tagCount = 0;
    let clearedCount = 0;
    this.allEvents().forEach(eventItem => {
      if (eventItem.isFixedGroup !== true || isDeletedEvent(eventItem)) return;
      const people = normalizeUsers(eventItem.attendees).length;
      if (people === 0) return;
      eventItem.attendees = [];
      eventItem.history = mergeHistoryEntries(eventItem.history, {
        id: "hist_reset_" + Date.now() + "_" + tagCount,
        author: String(payload.actorName || "管理員"),
        time: formatTaipei(new Date(now)),
        timestamp: now,
        type: "admin_reset",
        action: "管理員重置興趣名單"
      });
      eventItem.updatedAt = now;
      this.putEvent(eventItem);
      tagCount += 1;
      clearedCount += people;
    });
    this.appendAudit(payload, {
      eventId: "",
      actionType: "admin_reset_interests",
      action: "重置全部興趣調查，" + tagCount + " 個標籤共 " + clearedCount + " 人",
      details: { tagCount, clearedCount }
    });
    return { reset: tagCount, cleared: clearedCount };
  }

  adminRemoveAttendee(payload) {
    const eventId = requireText(payload.eventId, "缺少 eventId");
    const targetUserId = requireText(payload.targetUserId, "缺少 targetUserId");
    const actorUserId = requireText(payload.actorUserId, "缺少 actorUserId");
    const eventItem = this.requireEvent(eventId);
    assertActiveEvent(eventItem);

    const isHost = String(getHostUserId(eventItem)) === actorUserId;
    if (!isHost && !verifyAdminPassword(this.env, payload.adminPassword)) throw new Error("只有主揪或管理員可以移除成員。");
    if (String(getHostUserId(eventItem)) === targetUserId) throw new Error("主揪無法被移除，請先透過編輯更換主揪。");

    eventItem.attendees = normalizeUsers(eventItem.attendees).filter(user => String(user.userId) !== targetUserId);
    if (payload.historyEntry) eventItem.history = mergeHistoryEntries(eventItem.history, payload.historyEntry);
    eventItem.updatedAt = new Date().toISOString();
    this.putEvent(eventItem);

    this.appendAudit(payload, {
      eventId,
      actionType: "admin_remove_attendee",
      action: "管理員移除成員 " + (payload.targetUserName || targetUserId),
      details: { targetUserId, targetUserName: String(payload.targetUserName || ""), actorUserId }
    });
    return { eventId, attendees: eventItem.attendees, history: eventItem.history };
  }

  // 刪除只標記 status，實際移走由每日排程搬進 archive。
  softDeleteEvent(payload) {
    const eventId = requireText(payload.eventId || payload.id, "缺少 eventId");
    const eventItem = this.requireEvent(eventId);
    assertDeletePermission(this.env, eventItem, payload);
    if (isDeletedEvent(eventItem)) return { eventId, deleted: true, alreadyDeleted: true };

    const nowIso = new Date().toISOString();
    Object.assign(eventItem, {
      status: "deleted",
      deleted: true,
      deletedAt: String(payload.deletedAt || nowIso),
      deletedBy: String(payload.deletedBy || payload.actorName || ""),
      deletedByUserId: String(payload.deletedByUserId || payload.actorUserId || ""),
      updatedAt: nowIso,
      schemaVersion: CONFIG.SCHEMA_VERSION
    });
    const history = Array.isArray(payload.history) ? payload.history : [];
    eventItem.history = mergeHistoryEntries(eventItem.history, history[0] || null);
    this.putEvent(eventItem);

    this.appendAudit(payload, {
      eventId,
      actionType: "delete",
      action: "刪除活動",
      details: { deletedAt: eventItem.deletedAt, deletedBy: eventItem.deletedBy }
    });
    return { eventId, deleted: true };
  }

  // ---------- 打卡名單 ----------
  // 第一層：只能把自己加進名單，不能自己標記打卡成功；只認 actorUserId。
  checkIn(payload) {
    const actorUserId = requireText(payload.actorUserId, "尚未取得 LINE 身分，請重新登入後再打卡。");
    const displayName = String(payload.actorName || "未命名成員").trim().slice(0, CONFIG.MAX_MEMBER_NAME_LENGTH) || "未命名成員";
    const pictureUrl = String(payload.pictureUrl || "").trim().slice(0, 300);
    let member = this.getMember(actorUserId);
    const isNewMember = !member;

    if (member) {
      member.displayName = displayName;
      member.pictureUrl = pictureUrl || member.pictureUrl || "";
    } else {
      const count = this.sql.exec("SELECT COUNT(*) AS n FROM members").one().n;
      if (count >= CONFIG.MAX_MEMBERS) {
        throw new Error("打卡名單已達上限 " + CONFIG.MAX_MEMBERS + " 人，請管理員先移除不再參與的成員。");
      }
      member = { userId: actorUserId, displayName, pictureUrl, joinedAt: new Date().toISOString(), checkedInAt: "" };
    }
    this.putMember(member);

    this.appendAudit(payload, {
      eventId: "",
      actionType: "checkin",
      action: isNewMember ? displayName + " 登記打卡並加入名單" : displayName + " 重新登記（已在名單）",
      details: { userId: actorUserId, isNewMember }
    });
    return { member, isNewMember };
  }

  // 第二層：只有管理員能勾選打卡成功。
  adminSetCheckIn(payload) {
    assertAdminPermission(this.env, payload);
    const targetUserId = requireText(payload.targetUserId, "缺少 targetUserId");
    const checked = isTrue(payload.checked);
    const member = this.getMember(targetUserId);
    if (!member) throw new Error("名單中找不到這位成員，可能已被移除。");
    member.checkedInAt = checked ? new Date().toISOString() : "";
    this.putMember(member);

    this.appendAudit(payload, {
      eventId: "",
      actionType: checked ? "admin_check" : "admin_uncheck",
      action: (checked ? "勾選 " : "取消 ") + (member.displayName || targetUserId) + " 的打卡成功",
      details: { userId: targetUserId, checked }
    });
    return { member };
  }

  // 整列刪除：名單沒有歸檔需求，軟刪除只會讓它無限成長。紀錄留在 audit。
  adminRemoveMember(payload) {
    assertAdminPermission(this.env, payload);
    const targetUserId = requireText(payload.targetUserId, "缺少 targetUserId");
    const member = this.getMember(targetUserId);
    if (!member) throw new Error("名單中找不到這位成員，可能已被移除。");
    this.sql.exec("DELETE FROM members WHERE userId = ?", targetUserId);
    this.appendAudit(payload, {
      eventId: "",
      actionType: "admin_remove_member",
      action: "將 " + (member.displayName || targetUserId) + " 移出打卡名單",
      details: { userId: targetUserId }
    });
    return { removedUserId: targetUserId };
  }

  adminResetCheckIns(payload) {
    assertAdminPermission(this.env, payload);
    const members = this.allMembers();
    members.forEach(member => { member.checkedInAt = ""; this.putMember(member); });
    this.appendAudit(payload, {
      eventId: "",
      actionType: "admin_reset_checkins",
      action: "重置全部打卡狀態，共 " + members.length + " 人",
      details: { memberCount: members.length }
    });
    return { reset: members.length };
  }

  // ---------- 每日排程 ----------
  daily() {
    const now = new Date();
    let fulfilled = 0;
    let removed = 0;
    let moved = 0;
    this.ctx.storage.transactionSync(() => {
      this.allEvents().forEach(eventItem => {
        // 許願結算：滿 3 個日曆天，超過 3 人就轉一般活動，否則硬刪除（使用者要求不留檔）
        if (eventItem.isWish === true && !isDeletedEvent(eventItem)) {
          const createdAt = new Date(eventItem.createdAt);
          if (!isNaN(createdAt.getTime()) && taipeiDayDiff(createdAt, now) >= CONFIG.WISH_LIFESPAN_DAYS) {
            if (normalizeUsers(eventItem.attendees).length > CONFIG.WISH_MIN_ATTENDEES) {
              eventItem.isWish = false;
              this.putEvent(eventItem);
              fulfilled += 1;
            } else {
              this.sql.exec("DELETE FROM events WHERE id = ?", eventItem.id);
              removed += 1;
            }
            return;
          }
        }
        // 已刪除或過期超過保留期的活動搬進 archive
        if (isRetiredEvent(eventItem)) {
          this.sql.exec("INSERT INTO archive (id, archivedAt, data) VALUES (?, ?, ?)", eventItem.id, now.toISOString(), JSON.stringify(eventItem));
          this.sql.exec("DELETE FROM events WHERE id = ?", eventItem.id);
          moved += 1;
        }
      });
    });
    return { status: "success", fulfilled, removed, moved };
  }
}

// ---------- 權限 ----------
function verifyAdminPassword(env, password) {
  return safeEquals(password, env.ADMIN_PASSWORD);
}

function safeEquals(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b) return false;
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function assertAdminPermission(env, payload) {
  if (!verifyAdminPassword(env, payload.adminPassword)) throw new Error("只有管理員可以執行此操作。");
}

function assertHostPermission(eventItem, actorUserId) {
  const hostUserId = getHostUserId(eventItem);
  if (!actorUserId || !hostUserId || String(actorUserId) !== hostUserId) throw new Error("只有目前主揪可以執行此操作。");
}

function assertDeletePermission(env, eventItem, payload) {
  if (verifyAdminPassword(env, payload.adminPassword)) return;
  assertHostPermission(eventItem, String(payload.actorUserId || payload.deletedByUserId || ""));
}

// 主揪、管理員或任何已報名的成員都能改活動內容（刻意開放）。
function assertEditPermission(env, eventItem, payload) {
  const actorUserId = String(payload.actorUserId || "");
  if (verifyAdminPassword(env, payload.adminPassword)) return;
  if (actorUserId && String(getHostUserId(eventItem)) === actorUserId) return;
  if (actorUserId && normalizeUsers(eventItem.attendees).some(user => String(user.userId) === actorUserId)) return;
  throw new Error("只有已報名的成員、主揪或管理員可以編輯活動內容。");
}

// 交棒只限主揪與管理員，不可沿用 assertEditPermission，否則報名者能把自己設成主揪。
function assertHandoffPermission(env, eventItem, payload) {
  if (verifyAdminPassword(env, payload.adminPassword)) return;
  assertHostPermission(eventItem, String(payload.actorUserId || ""));
}

function assertActiveEvent(eventItem) {
  if (isDeletedEvent(eventItem)) throw new Error("此活動已刪除，無法再修改。");
}

// ---------- 活動資料整理 ----------
function normalizeEvent(payload, existingEvent) {
  const source = Object.assign({}, existingEvent || {}, payload);
  return {
    id: String(source.id || ""),
    status: String(source.status || "active"),
    title: String(source.title || "").trim(),
    datetime: String(source.datetime || ""),
    isFixedGroup: isTrue(source.isFixedGroup),
    isWish: isTrue(source.isWish),
    isHighlighted: isTrue(source.isHighlighted),
    fixedTimeText: String(source.fixedTimeText || "").trim(),
    location: String(source.location || "待定"),
    hostName: String(source.hostName || (source.hostUser && source.hostUser.displayName) || ""),
    hostUser: normalizeUser(source.hostUser),
    fee: String(source.fee || "免費"),
    maxAttendees: Math.max(0, Number(source.maxAttendees || 0)),
    description: String(source.description || ""),
    attendees: normalizeUsers(source.attendees),
    history: trimHistory(source.history),
    createdAt: String(source.createdAt || ""),
    updatedAt: String(source.updatedAt || ""),
    deletedAt: String(source.deletedAt || ""),
    deletedBy: String(source.deletedBy || ""),
    deletedByUserId: String(source.deletedByUserId || ""),
    schemaVersion: CONFIG.SCHEMA_VERSION
  };
}

// 匯入舊資料時清掉日曆欄位與舊版固定團的拆分名單
function normalizeStoredEvent(eventItem) {
  const normalized = normalizeEvent(eventItem, null);
  normalized.attendees = normalizeUsers(normalizeUsers(eventItem.attendees)
    .concat(normalizeUsers(eventItem.fixedAttendees), normalizeUsers(eventItem.weeklyAttendees)));
  normalized.deleted = isDeletedEvent(eventItem);
  return normalized;
}

function normalizeUsers(users) {
  const unique = new Map();
  (Array.isArray(users) ? users : []).forEach(user => {
    const normalized = normalizeUser(user);
    if (normalized) unique.set(normalized.userId, normalized);
  });
  return Array.from(unique.values());
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") return null;
  const userId = String(user.userId || "").trim();
  if (!userId) return null;
  return { userId, displayName: String(user.displayName || "未命名成員"), pictureUrl: String(user.pictureUrl || "") };
}

// history 只留最近 50 筆（新的在前）；興趣標籤永不過期，沒有上限會無限長大。
function trimHistory(history) {
  const list = Array.isArray(history) ? history : [];
  return list.slice(0, CONFIG.MAX_EVENT_HISTORY);
}

const historyKey = entry => String(entry.id || "") || [entry.author, entry.time, entry.action].join("|");

function mergeHistoryEntries(history, entry) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (entry && entry.action && !list.some(item => historyKey(item) === historyKey(entry))) list.unshift(entry);
  return trimHistory(list);
}

function mergeHistoryLists(currentHistory, incomingHistory) {
  const incoming = Array.isArray(incomingHistory) ? incomingHistory : [];
  const current = Array.isArray(currentHistory) ? currentHistory : [];
  const merged = [];
  incoming.concat(current).forEach(entry => {
    if (entry && entry.action && !merged.some(item => historyKey(item) === historyKey(entry))) merged.push(entry);
  });
  return trimHistory(merged);
}

function getChangedFields(previousEvent, nextEvent) {
  if (!previousEvent) return ["created"];
  return ["title", "datetime", "fixedTimeText", "location", "hostName", "fee", "maxAttendees", "description"]
    .filter(field => JSON.stringify(previousEvent[field] ?? "") !== JSON.stringify(nextEvent[field] ?? ""));
}

function getLatestHistoryAction(eventItem) {
  const entry = Array.isArray(eventItem.history) ? eventItem.history[0] : null;
  return entry && entry.action ? String(entry.action) : "";
}

function getHostUserId(eventItem) {
  if (eventItem && eventItem.hostUser && eventItem.hostUser.userId) return String(eventItem.hostUser.userId);
  const hostName = String((eventItem && eventItem.hostName) || "");
  const matches = normalizeUsers((eventItem && eventItem.attendees) || []).filter(user => user.displayName === hostName);
  return matches.length === 1 ? String(matches[0].userId) : "";
}

function isDeletedEvent(eventItem) {
  return Boolean(eventItem) && (eventItem.deleted === true || String(eventItem.status || "").toLowerCase() === "deleted");
}

// ---------- 時間（台北） ----------
function parseStartTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (local) return new Date(Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4], +local[5]) - CONFIG.TZ_OFFSET_MS);
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function isEventEnded(eventItem) {
  if (!eventItem || eventItem.isFixedGroup === true) return false;
  const start = parseStartTime(eventItem.datetime);
  return Boolean(start) && start.getTime() + CONFIG.EVENT_DURATION_MS < Date.now();
}

// 已刪除，或過期後超過 24 小時保留期。興趣標籤與時間無法解析的活動永遠不退場。
function isRetiredEvent(eventItem) {
  if (!eventItem) return false;
  if (isDeletedEvent(eventItem)) return true;
  if (!isEventEnded(eventItem)) return false;
  return parseStartTime(eventItem.datetime).getTime() + CONFIG.EVENT_DURATION_MS + CONFIG.EXPIRED_EVENT_RETENTION_MS < Date.now();
}

function taipeiDayDiff(from, to) {
  const day = date => Math.floor((date.getTime() + CONFIG.TZ_OFFSET_MS) / 86400000);
  return day(to) - day(from);
}

function formatTaipei(date) {
  const d = new Date(date.getTime() + CONFIG.TZ_OFFSET_MS);
  const pad = n => String(n).padStart(2, "0");
  return pad(d.getUTCMonth() + 1) + "/" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

// ---------- Google 地圖短網址 ----------
// 只追允許的 Google Maps 網域，不可放寬成任意網址（SSRF）。
async function resolveMapLocation(locationValue) {
  const location = String(locationValue || "").trim();
  const urlMatch = location.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return { location: location || "待定", displayName: location || "待定", mapUrl: "" };

  const mapUrl = urlMatch[0];
  const existingName = stripLocationUrl(location, mapUrl);
  if (!isAllowedMapsUrl(mapUrl)) return { location, displayName: existingName || "地點連結", mapUrl };
  if (existingName) return { location: existingName + " " + mapUrl, displayName: existingName, mapUrl };

  let currentUrl = mapUrl;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(currentUrl, { redirect: "manual" });
      if (response.status < 300 || response.status >= 400) break;
      const nextUrl = new URL(response.headers.get("location") || "", currentUrl).toString();
      if (!isAllowedMapsUrl(nextUrl)) break;
      currentUrl = nextUrl;
    } catch (error) {
      break;
    }
  }
  const displayName = extractMapsLabel(currentUrl) || "Google 地圖位置";
  return { location: displayName + " " + mapUrl, displayName, mapUrl };
}

function stripLocationUrl(location, mapUrl) {
  return String(location || "").replace(mapUrl, " ").replace(/^[\s|,，:：\-]+|[\s|,，:：\-]+$/g, "").trim();
}

function isAllowedMapsUrl(urlValue) {
  const match = String(urlValue || "").match(/^https?:\/\/([^\/?#]+)/i);
  if (!match) return false;
  const hostname = match[1].toLowerCase().replace(/:\d+$/, "");
  return hostname === "maps.app.goo.gl" || hostname === "goo.gl" || /^(?:www\.|maps\.)?google\.(?:com|com\.tw)$/.test(hostname);
}

function extractMapsLabel(url) {
  const match = url.match(/[?&](?:q|query|destination)=([^&#]+)/i) || url.match(/\/maps\/(?:place|search)\/([^/?#]+)/i);
  if (!match) return "";
  let value = match[1].replace(/\+/g, " ");
  try { value = decodeURIComponent(value); } catch (ignore) {}
  value = value.replace(/\s+/g, " ").trim();
  if (!value || /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(value)) return "";
  return value.slice(0, 160);
}

// ---------- 小工具 ----------
function requireText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}

function isTrue(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function newLogId() {
  return "log_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}
