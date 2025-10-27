function $(sel, root) { return (root || document).querySelector(sel); }
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el[k.toLowerCase()] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
  return el;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = ct.includes("application/json") ? await r.json() : await r.text(); msg = j.detail || j || msg; } catch {}
    throw new Error(typeof msg === "string" ? msg : "Request failed");
  }
  return ct.includes("application/json") ? r.json() : r.text();
}

function fmtDate(iso) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}
function _norm(s) { return (s || "").toString().trim().toLowerCase(); }

const state = {
  me: null,
  vocab: [],
  random: null,
  day: 1,
  answer: "",
  check: null,
  view: "loading",
  revealed: new Set(),
};

async function loadMe() {
  try {
    state.me = await api("/me");
    state.view = "main";
  } catch {
    state.me = null;
    state.view = "auth";
  }
}

async function signup(e) {
  e.preventDefault();
  const email = $("#signup-email").value.trim();
  const password = $("#signup-pass").value;
  if (!email || !password) return alert("กรอกอีเมลและรหัสผ่าน");
  try {
    await api("/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    await signinDirect(email, password);
  } catch (err) {
    alert(err.message || "สมัครไม่สำเร็จ");
  }
}

async function signin(e) {
  e.preventDefault();
  const email = $("#signin-email").value.trim();
  const password = $("#signin-pass").value;
  await signinDirect(email, password);
}

async function signinDirect(email, password) {
  if (!email || !password) return alert("กรอกอีเมลและรหัสผ่าน");
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ email, password }) });
    await initAfterAuth();
  } catch (err) {
    alert(err.message || "เข้าสู่ระบบไม่สำเร็จ");
  }
}

async function logout() {
  try {
    await api("/logout", { method: "POST" });
  } catch (e) {
    try { await api("/logout", { method: "GET" }); } catch {}
  }

  state.me = null;
  state.vocab = [];
  state.random = null;
  state.day = 1;
  state.answer = "";
  state.check = null;
  state.view = "auth";
  render();

  try {
    const url = new URL(location.href);
    url.searchParams.set("_", String(Date.now()));
    location.replace(url.toString());
  } catch {
    location.reload();
  }
}

async function loadList() {
  try {
    const r = await api("/vocab/list");
    state.vocab = (r.items || []).map(x => ({
      id: x.id, date: x.date, day_no: x.day_no, word: x.word, translation: x.translation
    }));
    state.day = state.vocab.length > 0 ? 1 : 1;
  } catch (err) {
    console.error(err);
    state.vocab = [];
    state.day = 1;
  }
}

async function refreshRandom() {
  try {
    const r = await api("/vocab/random?limit=1");
    state.random = (r.items && r.items[0]) ? r.items[0] : null;
  } catch {
    state.random = null;
  }
}

async function addTodayPrompt(force = false) {
  try {
    const r = await api("/vocab/today/auto", {
      method: "POST",
      body: JSON.stringify({ force })
    });
    await loadList();
    await refreshRandom();

    if (r && r.item && r.item.day_no) {
      state.day = r.item.day_no;
    }

    render();
  } catch (err) {
    alert(err.message || "เพิ่ม/เปลี่ยนคำของวันนี้ไม่สำเร็จ");
  }
}

async function resetAll() {
  if (!confirm("แน่ใจหรือไม่ว่าจะล้างคำศัพท์และสถิติทั้งหมด?")) return;
  try {
    await api("/vocab/reset", { method: "POST" });
    state.vocab = []; state.random = null; state.day = 1; state.answer = ""; state.check = null;
    state.revealed.clear();
    await loadList();
    await refreshRandom();
    render();
    alert("รีเซ็ตข้อมูลเรียบร้อยแล้ว");
  } catch (err) {
    alert(err.message || "รีเซ็ตล้มเหลว");
  }
}

function currentItem() {
  if (!state.vocab || state.vocab.length === 0) return null;
  return state.vocab.find(x => x.day_no === state.day) || null;
}

function goPrevDay() {
  if (state.day > 1) { state.day -= 1; state.answer = ""; state.check = null; render(); }
}
function goNextDay() {
  const max = state.vocab.length ? state.vocab[state.vocab.length - 1].day_no : 1;
  if (state.day < max) { state.day += 1; state.answer = ""; state.check = null; render(); }
}
function setDayFromSelect(v) {
  const n = parseInt(v, 10);
  if (!Number.isNaN(n)) { state.day = n; state.answer = ""; state.check = null; render(); }
}

function checkAnswer() {
  const item = currentItem();
  if (!item) return alert("ยังไม่มีคำสำหรับวันนี้");
  const ok = _norm(state.answer) === _norm(item.translation);

  if (ok) {
    const maxDay = state.vocab.length ? state.vocab[state.vocab.length - 1].day_no : 1;
    if (state.day < maxDay) {
      state.day += 1;
    } else {
      try { window?.navigator?.vibrate?.(20); } catch {}
      alert("เยี่ยม! ทำครบทุกวันแล้ว");
    }
    state.answer = "";
    state.check = { ok: true };
  } else {
    state.check = { ok: false, gold: item.translation };
  }
  render();
}

function keyOfRow(r) {
  return r.id != null ? String(r.id) : `${r.day_no}-${r.word}`;
}
function toggleReveal(r) {
  const k = keyOfRow(r);
  if (state.revealed.has(k)) state.revealed.delete(k);
  else state.revealed.add(k);
  render();
}

function Header() {
  return h("div", { class: "header" },
    h("div", { class: "brand" },
      h("div", { class: "logo" }, "VT"),
      h("div", null,
        h("h1", null, "Vocab Time Capsule"),
        h("div", { class: "small" }, "วันละคำ + วันก่อนหน้า")
      )
    ),
    h("div", { class: "right" },
      state.me ? h("span", { class: "badge" }, state.me.email || "") : null,
      state.me ? h("button", { class: "ghost", onClick: resetAll }, "Reset") : null,
      state.me ? h("button", { class: "ghost", onClick: logout }, "Logout") : null
    )
  );
}

function RandomCard() {
  const w = state.random ? state.random.word : "—";
  const t = state.random ? state.random.translation : "กำลังโหลดคำศัพท์...";

  return h("div", { class: "card" },
    h("div", { class: "card-title" }, "Random Pick (พร้อมความหมาย)"),
    h("h2", null, w),
    h("p", null, t),
  );
}

function PracticeCard() {
  const has = state.vocab && state.vocab.length > 0;
  const item = currentItem();

  const select = h("select", { onChange: (e) => setDayFromSelect(e.target.value) },
    ...(state.vocab || []).map(x =>
      h("option", { value: x.day_no, selected: x.day_no === state.day }, `Day ${x.day_no} — ${fmtDate(x.date)}`))
  );

  return h("div", { class: "card" },
    h("div", { class: "card-title" }, "เลือกวันที่ต้องการตอบ"),
    h("div", { class: "row gap" },
      h("button", { class: "ghost", onClick: goPrevDay }, "← วันก่อนหน้า"),
      select,
      h("button", { class: "ghost", onClick: goNextDay }, "วันถัดไป →"),
    ),
    !has ? h("p", null, "ยังไม่มีคำสำหรับวันนี้") :
      h("div", null,
        h("div", { style: { margin: "12px 0 6px" } }, `Day ${item.day_no} - ${fmtDate(item.date)}`),
        h("h2", null, item.word),
        h("div", { class: "row gap", style: { marginTop: "8px" } },
          h("input", {
            type: "text",
            placeholder: "พิมพ์คำแปลของคำนี้",
            value: state.answer,
            onInput: (e) => { state.answer = e.target.value; }
          }),
          h("button", { onClick: checkAnswer }, "ตรวจคำตอบ"),
          h("button", {
            class: "ghost",
            onClick: () => { state.answer = ""; state.check = null; render(); }
          }, "ล้างคำตอบ")
        ),
        state.check ? (
          state.check.ok
            ? h("div", { class: "ok" }, "✅ ถูกต้อง! ไปวันถัดไปได้เลย")
            : h("div", { class: "ng" }, ["❌ ยังไม่ถูก!"])
        ) : null
      )
  );
}

function ListTable() {
  const rows = state.vocab || [];
  return h("div", { class: "card" },
    h("div", { class: "card-title" }, "คำศัพท์ทั้งหมด"),
    h("table", { class: "table" },
      h("thead", null,
        h("tr", null,
          h("th", null, "Day"),
          h("th", null, "Date"),
          h("th", null, "Word"),
          h("th", null, "Translation"),
          h("th", null, "Actions")
        )
      ),
      h("tbody", null,
        ...(rows.length ? rows.map(r => {
          const key = keyOfRow(r);
          const shown = state.revealed.has(key);
          return h("tr", null,
            h("td", null, r.day_no),
            h("td", null, fmtDate(r.date)),
            h("td", null, r.word),
            h("td", null,
              h("span", { class: shown ? "" : "masked", "aria-label": shown ? "translation" : "translation hidden" },
                shown ? r.translation : "••••••"
              )
            ),
            h("td", null,
              h("button", { class: "btn-xs", onClick: () => toggleReveal(r) }, shown ? "ซ่อน" : "แสดง")
            )
          );
        }) : [h("tr", null, h("td", { colSpan: 5, style: { textAlign: "center", opacity: .7 } }, "— ไม่มีข้อมูล —"))])
      )
    )
  );
}

function AuthView(){
  return h("div", { class: "container" },
    h("div", { class: "header" },
      h("div", { class: "brand" },
        h("div", { class: "logo" }, "VT"),
        h("div", null,
          h("h1", null, "Vocab Time Capsule"),
          h("div", { class: "small" }, "วันละ 1 คำ + ฝึกทบทวนตามวัน")
        )
      )
    ),

    h("div", { class: "grid2" },

      h("div", { class: "card card-auth" },
        h("div", { class: "card-title" }, "Sign in"),
        h("form", { onSubmit: signin },
          h("input", { id: "signin-email", type: "email", placeholder: "อีเมล", required: true }),
          h("input", { id: "signin-pass", type: "password", placeholder: "รหัสผ่าน", required: true, style:{marginLeft:"8px", marginRight:"8px"} }),
          h("button", { type: "submit" }, "Sign in")
        )
      ),

      h("div", { class: "card card-auth" },
        h("div", { class: "card-title" }, "Sign up"),
        h("form", { onSubmit: signup },
          h("input", { id: "signup-email", type: "email", placeholder: "อีเมล", required: true }),
          h("input", { id: "signup-pass", type: "password", placeholder: "รหัสผ่าน", required: true, style:{marginLeft:"8px", marginRight:"8px"} }),
          h("button", { type: "submit" }, "Sign up")
        )
      )

    ),

    h("div", { class: "card" },
      h("div", { class: "card-title" }, "หรือเข้าสู่ระบบด้วย"),
      h("div", { class: "row gap" },
        h("a", { class: "btn-google", href: "/auth/google/login" }, "Continue with Google")
      )
    )
  );
}

function MainView() {
  return h("div", { class: "container" },
    Header(),
    h("div", { class: "grid2" },
      RandomCard(),
      PracticeCard()
    ),
    ListTable()
  );
}

function Loading() {
  return h("div", { class: "container" },
    h("div", { class: "card" }, h("div", { class: "card-title" }, "กำลังโหลด…"))
  );
}

function render() {
  const root = $("#app");
  if (!root) return;
  root.innerHTML = "";
  let view;
  if (state.view === "loading") view = Loading();
  else if (state.view === "auth") view = AuthView();
  else view = MainView();
  root.appendChild(view);
}

async function initAfterAuth() {
  await loadMe();
  let needsManualRender = true;

  if (state.view === "main") {
    await loadList();

    if (!isTodaySet()) {
      try {
        await addTodayPrompt(false);
        needsManualRender = false;
      } catch (err) {
        console.error("Auto-draw failed:", err.message);
        await refreshRandom();
      }
    } else {
      await refreshRandom();
    }
  }

  if (needsManualRender) {
    render();
  }
}

async function boot() {
  state.view = "loading";
  render();
  await initAfterAuth();
}

function isTodaySet(){
  const today = new Date().toISOString().slice(0,10);
  return (state.vocab||[]).some(x => fmtDate(x.date) === today);
}

document.addEventListener("DOMContentLoaded", boot);