(function() {
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "light") {
    document.body.classList.add("light-mode");
  }
})();

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
function toggleTheme() {
  if (document.body.classList.contains("light-mode")) {
    document.body.classList.remove("light-mode");
    localStorage.setItem("theme", "dark");
  } else {
    document.body.classList.add("light-mode");
    localStorage.setItem("theme", "light");
  }
}
const state = {
  me: null,
  vocab: [],
  random: null,
  day: 1,
  answer: "",
  check: null,
  view: "loading",
  revealed: new Set(),
  listSearch: "",
  listPage: 1
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
  state.listSearch = "";
  state.listPage = 1;
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
    state.listSearch = "";
    state.listPage = 1;
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

function _matchesTranslation(answer, translation) {
  const a = _norm(answer);
  const alts = _toTranslationsArray(translation);
  return alts.some(t => _norm(t) === a);
}

function formatTranslation(t) {
  const alts = _toTranslationsArray(t);
  return alts.join(" / ");
}

function _toTranslationsArray(t) {
  if (!t && t !== 0) return [];
  if (Array.isArray(t)) return t.map(x => (x ?? "").toString().trim()).filter(Boolean);
  if (typeof t === "string") {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(x => (x ?? "").toString().trim()).filter(Boolean);
    } catch {}
    if (t.includes("||")) return t.split("||").map(x => x.trim()).filter(Boolean);
    if (t.includes("|")) return t.split("|").map(x => x.trim()).filter(Boolean);
    if (t.includes(",")) {
      const parts = t.split(",").map(x => x.trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    return [t.trim()];
  }
  return [String(t).trim()];
}

function checkAnswer() {
  const item = currentItem();
  if (!item) return alert("ยังไม่มีคำสำหรับวันนี้");
  const ok = _matchesTranslation(state.answer, item.translation);

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
    const gold = Array.isArray(item.translation) ? item.translation.join(" / ") : item.translation;
    state.check = { ok: false, gold };
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
      h("button", { class: "ghost", onClick: toggleTheme, title: "เปลี่ยนธีม" }, "☀️/🌙"),
      state.me ? h("button", { class: "ghost", onClick: resetAll }, "Reset") : null,
      state.me ? h("button", { class: "ghost", onClick: logout }, "Logout") : null
    )
  );
}

function RandomCard() {
  const w = state.random ? state.random.word : "—";

  return h("div", { class: "card" },
    h("div", { class: "card-title" }, "Random Pick"),
    h("h2", null, w),
  );
}

function PracticeCard() {
  const has = state.vocab && state.vocab.length > 0;
  const item = currentItem();

  const select = h("select", { onChange: (e) => setDayFromSelect(e.target.value) },
    ...(state.vocab || []).map(x =>
      h("option", { value: x.day_no, selected: x.day_no === state.day }, `Day ${x.day_no} — ${fmtDate(x.date)}`))
  );
  select.value = state.day;
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
  const pageSize = 10;
  const searchLower = _norm(state.listSearch);

  const allRows = state.vocab || [];
  const filteredRows = allRows.filter(r => {
    if (!searchLower) return true;
    return _norm(r.word).includes(searchLower) || _norm(r.translation).includes(searchLower);
  });

  const totalPages = Math.ceil(filteredRows.length / pageSize);
  if (state.listPage > totalPages && totalPages > 0) state.listPage = totalPages;
  if (state.listPage < 1) state.listPage = 1;

  const start = (state.listPage - 1) * pageSize;
  const end = start + pageSize;
  const rows = filteredRows.slice(start, end);

  const searchInput = h("input", {
    type: "text",
    placeholder: "ค้นหาคำศัพท์ หรือ คำแปล...",
    value: state.listSearch,
    style: { minWidth: "260px", marginRight: "700px" },
    onChange: (e) => {
      state.listSearch = e.target.value;
      state.listPage = 1;
      render();
    }
  });

  const prevButton = h("button", {
    class: "ghost",
    style: { minWidth: "80px" },
    onClick: () => {
      if (state.listPage > 1) {
        state.listPage--;
        render();
      }
    }
  }, "← ก่อน");
  prevButton.disabled = state.listPage <= 1;

  const nextButton = h("button", {
    class: "ghost",
    style: { minWidth: "80px" },
    onClick: () => {
      if (state.listPage < totalPages) {
        state.listPage++;
        render();
      }
    }
  }, "ถัดไป →");
  nextButton.disabled = state.listPage >= totalPages;

  const handlePageChange = (e) => {
    const newPage = parseInt(e.target.value, 10);
    const maxPage = totalPages > 0 ? totalPages : 1;
    if (!Number.isNaN(newPage) && newPage >= 1 && newPage <= maxPage) {
      if (state.listPage !== newPage) {
        state.listPage = newPage;
        render();
      }
    } else {
      e.target.value = state.listPage;
    }
  };

  const pageInput = h("input", {
    type: "number",
    value: state.listPage,
    min: 1,
    max: totalPages > 0 ? totalPages : 1,
    style: {
      width: "70px",
      textAlign: "center",
      margin: "0 6px",
    },
    
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        handlePageChange(e);
        e.target.blur();
      }
    },
    onBlur: (e) => {
      handlePageChange(e);
    }
  });

  const totalPagesDisplay = h("span", { style: { opacity: 0.7, marginRight: "10px" } },
    `/ ${totalPages > 0 ? totalPages : 1}`
  );

  return h("div", { class: "card", style: { overflow: "hidden" } },
    h("div", { class: "row", style: { marginBottom: "16px", justifyContent: "space-between", alignItems: "center" } },
      h("div", { class: "card-title", style: { marginBottom: 0 } }, "คำศัพท์ทั้งหมด"),
      searchInput
    ),

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
      h("tbody", { style: { minHeight: "480px" } },
        ...(rows.length ? rows.map(r => {
          const key = keyOfRow(r);
          const shown = state.revealed.has(key);
          return h("tr", null,
            h("td", null, r.day_no),
            h("td", null, fmtDate(r.date)),
            h("td", null, r.word),
            h("td", null,
              h("span", { class: shown ? "" : "masked", "aria-label": shown ? "translation" : "translation hidden" },
                shown ? formatTranslation(r.translation) : "••••••"
              )
            ),
            h("td", null,
              h("button", { class: "btn-xs", onClick: () => toggleReveal(r) }, shown ? "ซ่อน" : "แสดง")
            )
          );
        }) : [h("tr", null, h("td", { colSpan: 5, style: { textAlign: "center", opacity: .7 } }, "— ไม่พบข้อมูล —"))])
      )
    ),

    h("div", { class: "row", style: { marginTop: "16px", justifyContent: "flex-end", alignItems: "center" } },
      prevButton,
      pageInput,
      totalPagesDisplay,
      nextButton
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
    h("div", { class: "card-title" }, "Sign up"),
    h("form", { onSubmit: signup },
     h("input", { id: "signup-email", type: "email", placeholder: "อีเมล", required: true }),
     h("input", { id: "signup-pass", type: "password", placeholder: "รหัสผ่าน", required: true })
    )
   ),

   h("div", { class: "card card-auth" },
    h("div", { class: "card-title" }, "Sign in"),
    h("form", { onSubmit: signin },
     h("input", { id: "signin-email", type: "email", placeholder: "อีเมล", required: true }),
     h("input", { id: "signin-pass", type: "password", placeholder: "รหัสผ่าน", required: true })
    ),
        
        h("div", { class: "divider-or" }, "หรือ"),
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
 document.body.classList.remove("view-loading", "view-auth", "view-main");
 document.body.classList.add(`view-${state.view}`);
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