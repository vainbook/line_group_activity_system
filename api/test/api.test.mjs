/* 本機測試：先開 wrangler dev，再跑這支。
     cd api && rm -rf .wrangler && npx wrangler@4 dev --port 8799 --test-scheduled
     node test/api.test.mjs
   .dev.vars 的管理員密碼是 test-admin、匯入密語是 test-import，碰不到正式資料。 */
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:8799";
const ADMIN = "test-admin";
let seq = 0;
const post = async body => (await fetch(BASE + "/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) })).json();
const get = async () => (await fetch(BASE + "/?_ts=1")).json();
const ok = j => { assert.equal(j.status, "success", j.message); return j; };
const fail = (j, text) => { assert.equal(j.status, "error"); if (text) assert.match(j.message, text); };
const step = async (name, fn) => { await fn(); console.log("ok  " + name); };
const user = id => ({ userId: id, displayName: "成員" + id, pictureUrl: "" });
const iso = ms => new Date(Date.now() + ms).toISOString();
// 台北當地時間字串，跟前端送的格式一樣
const taipei = ms => new Date(Date.now() + ms + 8 * 3600e3).toISOString().slice(0, 16);
const mid = () => "m" + Date.now() + "_" + (seq++);

await step("匯入舊資料（含固定團舊欄位）", async () => {
  const j = ok(await post({ action: "importSnapshot", importSecret: "test-import",
    events: [
      { id: "old1", title: "舊活動", datetime: taipei(86400e3), hostUser: user("A"), hostName: "成員A", attendees: [user("A")], history: [], calendarEventId: "x" },
      { id: "tag1", title: "喝酒", isFixedGroup: true, hostUser: user("A"), attendees: [user("A")], fixedAttendees: [user("B")], history: [] }
    ],
    members: [{ userId: "A", displayName: "成員A", pictureUrl: "", joinedAt: iso(0), checkedInAt: "" }] }));
  assert.equal(j.events, 2);
  fail(await post({ action: "importSnapshot", importSecret: "test-import", events: [] }), /已經有資料/);
  const data = ok(await get());
  assert.equal(data.schemaVersion, "5");
  const tag = data.events.find(e => e.id === "tag1");
  assert.deepEqual(tag.attendees.map(u => u.userId), ["A", "B"]);
  assert.equal(data.events.find(e => e.id === "old1").calendarEventId, undefined);
});

await step("建立活動：主揪必須是自己", async () => {
  fail(await post({ action: "saveEvent", id: "e1", actorUserId: "B", hostUser: user("A"), title: "x" }), /主揪相同/);
  const j = ok(await post({ action: "saveEvent", mutationId: mid(), id: "e1", actorUserId: "A", hostUser: user("A"), hostName: "成員A",
    title: "爬山", datetime: taipei(3 * 86400e3), maxAttendees: 2, isHighlighted: true, history: [{ id: "h1", action: "建立活動" }] }));
  assert.equal(j.event.isHighlighted, false);
  assert.deepEqual(j.event.attendees.map(u => u.userId), ["A"]);
});

await step("報名、額滿、重複 mutationId 不重複寫", async () => {
  const m = mid();
  ok(await post({ action: "toggleRSVP", mutationId: m, eventId: "e1", userId: "B", actorUserId: "B", rsvpAction: "join", displayName: "成員B" }));
  const dup = ok(await post({ action: "toggleRSVP", mutationId: m, eventId: "e1", userId: "B", actorUserId: "B", rsvpAction: "cancel" }));
  assert.equal(dup.duplicate, true);
  fail(await post({ action: "toggleRSVP", mutationId: mid(), eventId: "e1", userId: "C", actorUserId: "C", rsvpAction: "join" }), /已滿/);
  fail(await post({ action: "toggleRSVP", mutationId: mid(), eventId: "e1", userId: "B", actorUserId: "C", rsvpAction: "cancel" }), /自己/);
  fail(await post({ action: "toggleRSVP", mutationId: mid(), eventId: "e1", userId: "A", actorUserId: "A", rsvpAction: "cancel" }), /交棒/);
});

await step("編輯權限：報名者可改內容、不能交棒；名單不被前端覆蓋", async () => {
  const j = ok(await post({ action: "saveEvent", mutationId: mid(), id: "e1", actorUserId: "B", title: "爬山改", hostUser: user("B"), attendees: [] }));
  assert.equal(j.event.title, "爬山改");
  assert.equal(j.event.hostUser.userId, "A");
  assert.equal(j.event.attendees.length, 2);
  fail(await post({ action: "saveEvent", mutationId: mid(), id: "e1", actorUserId: "B", eventAction: "handoff", hostUser: user("B") }), /主揪/);
  fail(await post({ action: "saveEvent", mutationId: mid(), id: "e1", actorUserId: "Z", title: "亂改" }), /已報名/);
  const h = ok(await post({ action: "saveEvent", mutationId: mid(), id: "e1", actorUserId: "A", eventAction: "handoff", hostUser: user("B"), hostName: "成員B" }));
  assert.equal(h.event.hostUser.userId, "B");
});

await step("留言、推廣名額上限 3", async () => {
  fail(await post({ action: "addComment", mutationId: mid(), eventId: "e1", userId: "Z", text: "x".repeat(151) }), /150/);
  const c = ok(await post({ action: "addComment", mutationId: mid(), eventId: "e1", userId: "Z", displayName: "路人", text: "好耶", historyEntry: { action: "冒充系統" } }));
  assert.equal(c.entry.action, "好耶");
  for (const id of ["h1", "h2", "h3", "h4"]) {
    ok(await post({ action: "saveEvent", mutationId: mid(), id, actorUserId: "A", hostUser: user("A"), title: id, datetime: taipei(86400e3) }));
  }
  for (const id of ["h1", "h2", "h3"]) ok(await post({ action: "toggleHighlight", mutationId: mid(), eventId: id, actorUserId: "A", highlighted: true }));
  fail(await post({ action: "toggleHighlight", mutationId: mid(), eventId: "h4", actorUserId: "A", highlighted: true }), /3 個/);
  ok(await post({ action: "toggleHighlight", mutationId: mid(), eventId: "h1", actorUserId: "A", highlighted: false }));
  ok(await post({ action: "toggleHighlight", mutationId: mid(), eventId: "h4", actorUserId: "A", highlighted: true }));
});

await step("刪除：只有主揪或管理員；刪了就不出現在 GET", async () => {
  fail(await post({ action: "deleteEvent", mutationId: mid(), eventId: "h2", actorUserId: "B" }), /主揪/);
  ok(await post({ action: "deleteEvent", mutationId: mid(), eventId: "h2", actorUserId: "B", adminPassword: ADMIN }));
  assert.equal((await get()).events.some(e => e.id === "h2"), false);
  fail(await post({ action: "toggleRSVP", mutationId: mid(), eventId: "h2", userId: "B", actorUserId: "B", rsvpAction: "join" }), /已刪除/);
});

await step("打卡兩層權限", async () => {
  const j = ok(await post({ action: "checkIn", mutationId: mid(), actorUserId: "B", actorName: "成員B", checkedInAt: "偷偷" }));
  assert.equal(j.member.checkedInAt, "");
  fail(await post({ action: "adminSetCheckIn", mutationId: mid(), targetUserId: "B", checked: true, adminPassword: "錯" }), /管理員/);
  ok(await post({ action: "adminSetCheckIn", mutationId: mid(), targetUserId: "B", checked: true, adminPassword: ADMIN }));
  const again = ok(await post({ action: "checkIn", mutationId: mid(), actorUserId: "B", actorName: "新名字" }));
  assert.ok(again.member.checkedInAt, "重新登記不可清掉管理員勾的結果");
  assert.equal(ok(await post({ action: "adminResetCheckIns", mutationId: mid(), adminPassword: ADMIN })).reset, 2);
  ok(await post({ action: "adminRemoveMember", mutationId: mid(), targetUserId: "B", adminPassword: ADMIN }));
  assert.deepEqual((await get()).members.map(m => m.userId), ["A"]);
});

await step("興趣標籤：發起人可自己取消；管理員重置", async () => {
  ok(await post({ action: "toggleRSVP", mutationId: mid(), eventId: "tag1", userId: "A", actorUserId: "A", rsvpAction: "cancel" }));
  const r = ok(await post({ action: "adminResetInterests", mutationId: mid(), adminPassword: ADMIN }));
  assert.equal(r.cleared, 1);
});

await step("每日排程：許願結算、過期搬走", async () => {
  ok(await post({ action: "saveEvent", mutationId: mid(), id: "w1", actorUserId: "A", hostUser: user("A"), title: "許願", isWish: true, datetime: taipei(9 * 86400e3), createdAt: iso(-4 * 86400e3) }));
  ok(await post({ action: "saveEvent", mutationId: mid(), id: "old2", actorUserId: "A", hostUser: user("A"), title: "很久以前", datetime: taipei(-3 * 86400e3) }));
  const res = await fetch(new URL("/__scheduled?cron=5+16+*+*+*", BASE));
  assert.equal(res.status, 200);
  const ids = (await get()).events.map(e => e.id);
  assert.equal(ids.includes("w1"), false, "人數不夠的許願要刪掉");
  assert.equal(ids.includes("old2"), false);
  assert.equal(ids.includes("tag1"), true, "興趣標籤永不過期");
});

await step("管理員密碼驗證與地圖（不需網路的情況）", async () => {
  assert.equal((await post({ action: "verifyAdminPassword", adminPassword: ADMIN })).canDeleteAnyEvent, true);
  assert.equal((await post({ action: "verifyAdminPassword", adminPassword: "x" })).canDeleteAnyEvent, false);
  const m = ok(await post({ action: "resolveMapLocation", location: "家裡 https://example.com/x" }));
  assert.equal(m.displayName, "家裡");
  fail(await post({ action: "不存在" }), /不支援/);
});
console.log("全部通過");
