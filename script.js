/**
 * Family Budget App - script.js
 * Works with index.html (Login Screen + 4 pane SPA: Home, Summary, History, Settings)
 * Connects to Google Apps Script backend for Google Sheets data
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
const API_URL = "https://script.google.com/macros/s/AKfycbyl5j-SrJ1N8l5P31sHZreylmFywfp062AcxQAF-p29msDYpFQMKpij9uX1zCl43pwsnA/exec";

const USER_INFO = {
    mon:  { displayName: "ม่อน", engName: "Mon",  avatar: "M", theme: "theme-mon",  color: "#2563eb" },
    milk: { displayName: "มิ้ว", engName: "Milk", avatar: "K", theme: "theme-milk", color: "#f43f5e" }
};

const CATEGORIES = {
    expense: ["อาหาร","เครื่องดื่ม","ขนมของหวาน","ของใช้","เสื้อผ้า","ค่าเดินทาง","ค่าน้ำมัน","บิล/ค่าน้ำไฟ","ความงาม","สุขภาพ","บันเทิง","ของขวัญ","อื่นๆ"],
    income:  ["เงินเดือน","โบนัส","เงินติ๊กตอก","รายได้พิเศษ","อื่นๆ"]
};

// เวลาแจ้งเตือนประจำวัน (24h format) — ทำงานได้ก็ต่อเมื่อเปิดหน้าเว็บนี้ค้างอยู่ในเบราว์เซอร์
const REMINDER_TIMES = ["12:00", "18:00", "21:00"];

const CAT_ICONS = {
    "อาหาร":"🍜","เครื่องดื่ม":"☕","ขนมของหวาน":"🍰","ของใช้":"🛒","เสื้อผ้า":"👗",
    "ค่าเดินทาง":"🚌","ค่าน้ำมัน":"⛽","บิล/ค่าน้ำไฟ":"💡","ความงาม":"💄","สุขภาพ":"💊",
    "บันเทิง":"🎬","ของขวัญ":"🎁","เงินเดือน":"💰","โบนัส":"🎉","เงินติ๊กตอก":"📱",
    "รายได้พิเศษ":"💸","อื่นๆ":"📌","ใช้จ่ายกับแฟน":"💑"
};

// โหลดหมวดหมู่ที่ผู้ใช้เคยแก้ไขไว้ (ถ้ามี) มาทับค่าเริ่มต้น
function loadCategories() {
    try {
        const saved = JSON.parse(localStorage.getItem("custom_categories") || "null");
        if (saved && Array.isArray(saved.income) && saved.income.length && Array.isArray(saved.expense) && saved.expense.length) {
            CATEGORIES.income = saved.income;
            CATEGORIES.expense = saved.expense;
        }
    } catch (e) { /* ignore malformed data */ }
}
function saveCategories() {
    localStorage.setItem("custom_categories", JSON.stringify({ income: CATEGORIES.income, expense: CATEGORIES.expense }));
}
loadCategories();

let customGroups = {}; // { "อาหาร": ["ข้าว","ขนม","ขนมปัง"], ... } — ตั้งเองผ่านปุ่ม ⚙️ บนกราฟโดนัท
function loadGroups() {
    try {
        const saved = JSON.parse(localStorage.getItem("category_groups") || "null");
        if (saved && typeof saved === "object") customGroups = saved;
    } catch (e) { customGroups = {}; }
}
function saveGroups() {
    localStorage.setItem("category_groups", JSON.stringify(customGroups));
}
loadGroups();

// ─── STATE ──────────────────────────────────────────────────────────────────
let state = {
    user: null,            // "mon" or "milk"
    apiData: null,         // full data from API
    activePane: "home",    // "home" | "summary" | "history" | "settings"
    summaryMonth: null,    // { year: 2026, month: 6 } (0-indexed month)
    summaryFilter: "combined", // "combined" | "incomes" | "expenses"
    historyFilter: "all",  // "all" | "income" | "expense"
    historySearch: "",
    balanceHidden: false,
    editingTx: null,       // transaction being edited
    budget: 10000,         // monthly budget in baht
};

// ─── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    const savedUser = localStorage.getItem("budget_user");
    if (savedUser && USER_INFO[savedUser]) {
        loginAs(savedUser);
    } else {
        document.getElementById("loginScreen").classList.remove("hidden");
    }

    document.querySelectorAll(".user-card-btn").forEach(btn => {
        btn.addEventListener("click", () => loginAs(btn.dataset.user));
    });
});

function loginAs(user) {
    state.user = user;
    localStorage.setItem("budget_user", user);

    const info = USER_INFO[user];
    document.body.className = info.theme;

    // Apply user info to header
    document.getElementById("greetUserName").textContent = info.displayName;
    document.getElementById("avatarLetter").textContent = info.avatar;
    document.getElementById("txtProfileName").textContent = info.displayName;

    // Hide login, show app
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appLayout").classList.remove("hidden");

    // Init summary month to current
    const now = new Date();
    state.summaryMonth = { year: now.getFullYear(), month: now.getMonth() };
    state.budget = parseInt(localStorage.getItem("budget_amount") || "10000");

    setupEventListeners();
    loadData();
    scheduleReminders(); // จะทำงานจริงก็ต่อเมื่อเคยกดอนุญาต Notification ไว้แล้วเท่านั้น
}

// ─── EVENT LISTENERS ────────────────────────────────────────────────────────
function setupEventListeners() {
    // Bottom Nav
    document.querySelectorAll(".nav-item[data-target]").forEach(btn => {
        btn.addEventListener("click", () => switchPane(btn.dataset.target));
    });

    // FAB Add button
    document.getElementById("btnFloatingAdd").addEventListener("click", () => openAddSheet("expense"));

    // Notification bell
    document.getElementById("btnNotify").addEventListener("click", requestNotificationPermission);
    updateNotifyBadge();

    // Home shortcuts
    document.querySelectorAll(".shortcut-btn").forEach(btn => {
        btn.addEventListener("click", () => openAddSheet(btn.dataset.type));
    });

    // See all history
    document.getElementById("btnSeeAllHistory").addEventListener("click", () => switchPane("history"));

    // Balance toggle
    document.getElementById("btnToggleBalance").addEventListener("click", toggleBalance);

    // Summary month nav
    document.getElementById("btnPrevMonth").addEventListener("click", () => navigateMonth(-1));
    document.getElementById("btnNextMonth").addEventListener("click", () => navigateMonth(1));

    // Sub-tabs on summary
    document.querySelectorAll(".sub-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            state.summaryFilter = btn.dataset.subtab; // "combined" | "incomes" | "expenses"
            renderSummaryPane();
        });
    });

    // History search
    document.getElementById("inputSearchQuery").addEventListener("input", (e) => {
        state.historySearch = e.target.value.toLowerCase();
        renderHistoryPane();
    });

    // History filter pills
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            state.historyFilter = pill.dataset.filter;
            renderHistoryPane();
        });
    });

    // Add transaction form controls
    document.getElementById("btnCloseSheet").addEventListener("click", closeSheet);
    document.getElementById("addTransactionSheet").addEventListener("click", (e) => {
        if (e.target === document.getElementById("addTransactionSheet")) closeSheet();
    });

    document.querySelectorAll(".form-type-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            const radio = tab.querySelector("input");
            radio.checked = true;
            document.querySelectorAll(".form-type-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            updateCategoryOptions(radio.value);
        });
    });

    document.getElementById("transactionForm").addEventListener("submit", handleFormSubmit);

    // Detail modal
    document.getElementById("btnCloseDetailModal").addEventListener("click", closeDetailModal);
    document.getElementById("txDetailModal").addEventListener("click", (e) => {
        if (e.target === document.getElementById("txDetailModal")) closeDetailModal();
    });
    document.getElementById("btnEditTransaction").addEventListener("click", onEditClick);
    document.getElementById("btnDeleteTransaction").addEventListener("click", onDeleteClick);

    // Settings
    document.getElementById("btnLogout").addEventListener("click", logout);
    document.getElementById("btnReloadData").addEventListener("click", () => loadData(true));
    document.getElementById("btnEditBudget").addEventListener("click", editBudget);
    document.getElementById("btnManageCategories").addEventListener("click", openCategoryManager);

    // Category manager sheet
    document.getElementById("btnCloseCategoryManager").addEventListener("click", closeCategoryManager);
    document.getElementById("categoryManagerSheet").addEventListener("click", (e) => {
        if (e.target === document.getElementById("categoryManagerSheet")) closeCategoryManager();
    });
    document.querySelectorAll(".cat-type-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            categoryManagerType = tab.dataset.cattype;
            document.querySelectorAll(".cat-type-tab").forEach(t => t.classList.toggle("active", t === tab));
            renderCategoryManagerList();
        });
    });
    document.getElementById("btnAddCategory").addEventListener("click", addCategoryFromInput);
    document.getElementById("inputNewCategory").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addCategoryFromInput(); }
    });

    // Group manager (สำหรับกราฟโดนัท)
    document.getElementById("btnOpenGroupManager").addEventListener("click", openGroupManager);
    document.getElementById("btnCloseGroupManager").addEventListener("click", closeGroupManager);
    document.getElementById("groupManagerSheet").addEventListener("click", (e) => {
        if (e.target === document.getElementById("groupManagerSheet")) closeGroupManager();
    });
    document.getElementById("btnAddGroup").addEventListener("click", addGroupFromInput);
    document.getElementById("inputNewGroup").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addGroupFromInput(); }
    });

    // Quick classify
    document.getElementById("btnOpenQuickClassify").addEventListener("click", openQuickClassify);
    document.getElementById("btnCloseQuickClassify").addEventListener("click", closeQuickClassify);
    document.getElementById("quickClassifySheet").addEventListener("click", (e) => {
        if (e.target === document.getElementById("quickClassifySheet")) closeQuickClassify();
    });
}

// ─── NAVIGATION ─────────────────────────────────────────────────────────────
function switchPane(pane) {
    state.activePane = pane;
    document.querySelectorAll(".view-pane").forEach(p => p.classList.remove("active"));
    document.getElementById("pane-" + pane).classList.add("active");

    document.querySelectorAll(".nav-item[data-target]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.target === pane);
    });

    // Render the right content
    if (pane === "home") renderHomePane();
    else if (pane === "summary") renderSummaryPane();
    else if (pane === "history") renderHistoryPane();
}

// ─── DATA LOADING ────────────────────────────────────────────────────────────
const LOADING_STATUS_MESSAGES = [
    "กำลังเชื่อมต่อ...",
    "กำลังดึงข้อมูลจาก Google Sheets...",
    "กำลังประมวลผลรายการ...",
    "เกือบเสร็จแล้ว..."
];
const FETCH_TIMEOUT_MS = 25000; // ถ้าเกิน 25 วิยังไม่ตอบกลับ ถือว่า timeout

async function loadData(force = false) {
    if (!force && state.apiData) {
        refreshCurrentPane();
        return;
    }

    startLoadingScreen();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(API_URL + "?user=" + state.user + "&t=" + Date.now(), { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        state.apiData = data;
        finishLoadingScreen(true);
        refreshCurrentPane();

    } catch (err) {
        clearTimeout(timeoutId);
        console.error("loadData error:", err);
        const isTimeout = err.name === "AbortError";
        finishLoadingScreen(false, isTimeout ? "เชื่อมต่อนานเกินไป ลองใหม่อีกครั้ง" : "โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
}

function refreshCurrentPane() {
    if (state.activePane === "home") renderHomePane();
    else if (state.activePane === "summary") renderSummaryPane();
    else if (state.activePane === "history") renderHistoryPane();
}

// ─── HOME PANE ───────────────────────────────────────────────────────────────
function renderHomePane() {
    if (!state.apiData) return;

    const userData = state.apiData[state.user];
    if (!userData) return;

    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();

    // Filter transactions for current month
    const monthTxs = (userData.transactions || []).filter(tx => {
        const d = new Date(tx.rawDate);
        return d.getMonth() === curMonth && d.getFullYear() === curYear;
    });

    const income  = monthTxs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const expense = monthTxs.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    const balance = income - expense;

    // Update balance card
    const balEl = document.getElementById("txtBalanceValue");
    balEl.textContent = state.balanceHidden ? "฿ ••••••" : formatCurrency(balance);
    balEl.className = "balance-num " + (balance >= 0 ? "positive" : "negative");

    // Stats
    document.getElementById("txtHomeIncome").textContent = formatCurrency(income);
    document.getElementById("txtHomeExpense").textContent = formatCurrency(expense);
    document.getElementById("txtHomeIncomeCount").textContent = monthTxs.filter(t => t.amount > 0).length;
    document.getElementById("txtHomeExpenseCount").textContent = monthTxs.filter(t => t.amount < 0).length;

    // Budget bar
    const pct = state.budget > 0 ? Math.min(100, Math.round((expense / state.budget) * 100)) : 0;
    document.getElementById("txtBudgetPercent").textContent = pct + "%";
    document.getElementById("elBudgetProgress").style.width = pct + "%";
    document.getElementById("elBudgetProgress").className = "progress-bar-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warning" : "");
    document.getElementById("txtBudgetUsageLabel").textContent = `ใช้ไป ${formatCurrency(expense)} / ${formatCurrency(state.budget)}`;

    // Recent transactions (last 5)
    const recent = [...monthTxs].sort((a, b) => b.rawDate - a.rawDate).slice(0, 5);
    const list = document.getElementById("homeTransactionList");
    list.innerHTML = recent.length === 0
        ? `<li class="tx-empty">ยังไม่มีรายการในเดือนนี้</li>`
        : recent.map(tx => renderTxItem(tx)).join("");

    // Attach click listeners
    list.querySelectorAll(".tx-list-item").forEach(el => {
        el.addEventListener("click", () => openDetailModal(el.dataset.id));
    });
}

function toggleBalance() {
    state.balanceHidden = !state.balanceHidden;
    document.getElementById("eyeOpenIcon").classList.toggle("hidden", state.balanceHidden);
    document.getElementById("eyeClosedIcon").classList.toggle("hidden", !state.balanceHidden);
    renderHomePane();
}

// ─── SUMMARY PANE ────────────────────────────────────────────────────────────

// The API only returns the most recent 150 transactions per user (see backend),
// so for older months we must NOT recompute totals from `transactions` —
// use the pre-aggregated `summary` tab data instead, which covers all history.
function getSummaryEntry(year, month) {
    if (!state.apiData || !Array.isArray(state.apiData.summary)) return null;
    return state.apiData.summary.find(s => {
        const my = (s.monthYear || "").toString();
        if (my.length < 3) return false;
        const yearPart = parseInt(my.slice(-2), 10);
        const monthPart = parseInt(my.slice(0, my.length - 2), 10);
        return (2000 + yearPart) === year && (monthPart - 1) === month;
    }) || null;
}

function renderSummaryPane() {
    if (!state.apiData) return;

    const { year, month } = state.summaryMonth;
    const userData = state.apiData[state.user];
    if (!userData) return;

    // Update month label
    const thMonths = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                      "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
    const thYear = year + 543;
    document.getElementById("txtSelectedMonthLabel").textContent = `${thMonths[month]} ${thYear}`;

    // Filter transactions for selected month (used for the weekly chart only —
    // may be incomplete for older months due to the 150-item API limit)
    const txs = (userData.transactions || []).filter(tx => {
        const d = new Date(tx.rawDate);
        return d.getMonth() === month && d.getFullYear() === year;
    });

    // Use the pre-aggregated summary tab for the headline numbers (always accurate,
    // not limited to the last 150 transactions)
    const summaryEntry = getSummaryEntry(year, month);
    let income, expense, balance;
    if (summaryEntry) {
        income  = state.user === "mon" ? summaryEntry.monIncome  : summaryEntry.milkIncome;
        expense = state.user === "mon" ? summaryEntry.monExpense : summaryEntry.milkExpense;
        balance = income - expense;
    } else {
        // No summary row for this month (e.g. no transactions ever existed) — fall back to 0
        income = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
        expense = txs.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
        balance = income - expense;
    }

    const filter = state.summaryFilter || "combined";

    // Show/hide the split income/expense boxes and headline number based on filter
    const incBox = document.querySelector(".split-w.income");
    const expBox = document.querySelector(".split-w.expense");
    const divider = document.querySelector(".split-divider");
    const totalsLabel = document.querySelector(".totals-label");
    const totalsHeadline = document.getElementById("txtSummaryBalance");

    if (incBox) incBox.classList.toggle("hidden", filter === "expenses");
    if (expBox) expBox.classList.toggle("hidden", filter === "incomes");
    if (divider) divider.classList.toggle("hidden", filter !== "combined");

    if (filter === "incomes") {
        if (totalsLabel) totalsLabel.textContent = "รายรับรวม";
        totalsHeadline.textContent = formatCurrency(income);
    } else if (filter === "expenses") {
        if (totalsLabel) totalsLabel.textContent = "รายจ่ายรวม";
        totalsHeadline.textContent = formatCurrency(expense);
    } else {
        if (totalsLabel) totalsLabel.textContent = "ยอดคงเหลือ";
        totalsHeadline.textContent = formatCurrency(balance);
    }

    document.getElementById("txtSummaryIncome").textContent  = formatCurrency(income);
    document.getElementById("txtSummaryExpense").textContent = formatCurrency(expense);

    // Category breakdown donut chart (expense categories by default, income categories on the "รายรับ" tab)
    const topCat = renderCategoryBreakdown(txs, filter);

    // Auto insight: compare vs previous month + top category
    let prevMonth = month - 1, prevYear = year;
    if (prevMonth < 0) { prevMonth = 11; prevYear -= 1; }
    const prevEntry = getSummaryEntry(prevYear, prevMonth);
    renderSummaryInsight(income, expense, prevEntry, topCat, filter);

    // Chart: weekly breakdown for selected month
    renderWeeklyChart(txs, year, month, filter);

    // Family compare
    renderFamilyCompare(year, month, filter);
}

// ─── AUTO-CATEGORIZATION ──────────────────────────────────────────────────────
// รายการเก่าจำนวนมากถูกบันทึกด้วยชื่อสินค้า/ร้านค้าแบบพิมพ์เอง (เช่น "แกร็บ", "ก๋วยเตี๋ยว")
// แทนที่จะเป็นหมวดหมู่มาตรฐาน ฟังก์ชันนี้เดาหมวดหมู่ที่ใกล้เคียงที่สุดจากคำสำคัญ
// เพื่อให้กราฟโดนัทจัดกลุ่มได้อย่างมีความหมาย แทนที่จะแตกเป็นเสี้ยวเล็กๆ นับสิบ
const AUTO_CATEGORY_KEYWORDS = {
    "อาหาร": ["ข้าว","ก๋วยเตี๋ยว","ต้ม","ผัด","แกง","หมู","ไก่","เนื้อ","ปลา","ซูชิ","อาหาร","เที่ยง","มื้อเย็น","มื้อเช้า","มื้อ","ร้านอาหาร","บุฟเฟ่ต์","ส้มตำ","ก๋วยจั๊บ","เตี๋ยว"],
    "เครื่องดื่ม": ["กาแฟ","ชานม","น้ำอัดลม","ชาไทย","โกโก้","สมูทตี้","เครื่องดื่ม","ชาเขียว"],
    "ขนมของหวาน": ["ขนม","เค้ก","ไอศกรีม","โมจิ","พุดดิ้ง","ของหวาน","บิงซู","คุกกี้"],
    "ของใช้": ["หวี","สบู่","แชมพู","กระดาษทิชชู่","ของใช้","ผงซักฟอก","น้ำยา"],
    "เสื้อผ้า": ["เสื้อ","กางเกง","ชุดนอน","บรา","กระโปรง","รองเท้า","ผ้า","ช้อปปิ้ง"],
    "ค่าเดินทาง": ["แกร็บ","grab","วินมอไซค์","แท็กซี่","taxi","รถไฟฟ้า","bts","mrt","ค่าเดินทาง","รถตู้","รถทัวร์","วิน"],
    "ค่าน้ำมัน": ["น้ำมัน","ปั๊มน้ำมัน","เชื้อเพลิง"],
    "บิล/ค่าน้ำไฟ": ["ค่าน้ำ","ค่าไฟ","ค่าเน็ต","อินเทอร์เน็ต","ค่ามือถือ","บิล","ค่าโทรศัพท์"],
    "ความงาม": ["เล็บ","ทำผม","สปา","ความงาม","แต่งหน้า","เสริมสวย"],
    "สุขภาพ": ["หมอ","ค่ายา","โรงพยาบาล","ประกัน","คลินิก"],
    "บันเทิง": ["หนัง","เกม","คาราโอเกะ","เที่ยว","คอนเสิร์ต"],
    "ของขวัญ": ["ของขวัญ","gift"],
    "เงินเดือน": ["เงินเดือน","salary"],
    "โบนัส": ["โบนัส","bonus"],
    "รายได้พิเศษ": ["รายได้พิเศษ","พาร์ทไทม์","ฟรีแลนซ์"]
};

function classifyItem(rawItem) {
    if (!rawItem) return "อื่นๆ";
    const trimmed = String(rawItem).trim();
    const lower = trimmed.toLowerCase();

    // 1) ตรงกับหมวดหมู่มาตรฐานเป๊ะๆ อยู่แล้ว ใช้เลย
    if (CATEGORIES.income.includes(trimmed) || CATEGORIES.expense.includes(trimmed)) return trimmed;

    // 2) ตรงกับกลุ่มที่ผู้ใช้ตั้งเอง (สำคัญสุด เพราะผู้ใช้กำหนดเอง)
    for (const [group, items] of Object.entries(customGroups)) {
        if ((items || []).some(k => lower === k.toLowerCase() || lower.includes(k.toLowerCase()))) return group;
    }

    // 3) เดาแบบ built-in keyword fallback
    for (const [cat, keywords] of Object.entries(AUTO_CATEGORY_KEYWORDS)) {
        if (keywords.some(k => lower.includes(k.toLowerCase()))) return cat;
    }

    return "อื่นๆ";
}

// ─── CATEGORY BREAKDOWN DONUT ────────────────────────────────────────────────
const DONUT_COLORS = ["#2563eb","#f43f5e","#f59e0b","#10b981","#8b5cf6","#06b6d4","#ec4899","#84cc16","#f97316","#6366f1"];

function renderCategoryBreakdown(txs, filter) {
    const donutEl = document.getElementById("donutChart");
    const legendEl = document.getElementById("donutLegend");
    const centerLabel = document.getElementById("donutCenterLabel");
    const titleEl = document.getElementById("categoryBreakdownTitle");
    if (!donutEl || !legendEl) return null;

    const useIncome = filter === "incomes";
    titleEl.textContent = useIncome ? "สัดส่วนรายรับตามหมวดหมู่" : "สัดส่วนรายจ่ายตามหมวดหมู่";

    const relevant = txs.filter(t => useIncome ? t.amount > 0 : t.amount < 0);
    const sums = {};
    const unclassifiedSums = {}; // { rawItemText: totalAmount } — เก็บไว้ให้หน้าจัดหมวดหมู่ด่วนใช้ต่อ
    relevant.forEach(t => {
        const cat = classifyItem(t.item);
        sums[cat] = (sums[cat] || 0) + Math.abs(t.amount);

        if (cat === "อื่นๆ") {
            const raw = (t.item || "").trim() || "(ไม่มีชื่อ)";
            unclassifiedSums[raw] = (unclassifiedSums[raw] || 0) + Math.abs(t.amount);
        }
    });

    // เก็บไว้เป็น module-level state ให้หน้าจัดหมวดหมู่ด่วนดึงไปใช้โดยไม่ต้อง compute ซ้ำ
    lastUnclassifiedItems = Object.entries(unclassifiedSums)
        .map(([item, amount]) => ({ item, amount }))
        .sort((a, b) => b.amount - a.amount);
    lastUnclassifiedIsIncome = useIncome;
    renderUnclassifiedBanner();

    const entries = Object.entries(sums).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);

    if (entries.length === 0 || total === 0) {
        donutEl.style.background = "var(--bg-surface)";
        centerLabel.textContent = "฿0";
        legendEl.innerHTML = `<li class="tx-empty">ยังไม่มีข้อมูล</li>`;
        return null;
    }

    centerLabel.textContent = formatCompact(total);

    let cursor = 0;
    const stops = [];
    legendEl.innerHTML = "";

    entries.forEach(([cat, amt], i) => {
        const pct = (amt / total) * 100;
        const color = DONUT_COLORS[i % DONUT_COLORS.length];
        stops.push(`${color} ${cursor}% ${cursor + pct}%`);
        cursor += pct;

        const li = document.createElement("li");
        li.className = "donut-legend-item";
        li.innerHTML = `
            <span class="legend-dot" style="background:${color}"></span>
            <span class="legend-cat">${CAT_ICONS[cat] || "📌"} ${cat}</span>
            <span class="legend-pct">${pct.toFixed(0)}%</span>
        `;
        legendEl.appendChild(li);
    });

    donutEl.style.background = `conic-gradient(${stops.join(", ")})`;

    const [topName, topAmt] = entries[0];
    return { name: topName, pct: Math.round((topAmt / total) * 100) };
}

// ─── AUTO INSIGHT (month-over-month + top category) ──────────────────────────
function renderSummaryInsight(income, expense, prevEntry, topCat, filter) {
    const box = document.getElementById("summaryInsightBox");
    const textEl = document.getElementById("insightText");
    if (!box || !textEl) return;

    const parts = [];

    if (prevEntry) {
        const prevIncome  = state.user === "mon" ? prevEntry.monIncome  : prevEntry.milkIncome;
        const prevExpense = state.user === "mon" ? prevEntry.monExpense : prevEntry.milkExpense;

        if (filter === "incomes") {
            const t = buildTrendText("รายรับ", income, prevIncome);
            if (t) parts.push(t);
        } else {
            // combined and expenses tab both lead with the spending trend — most actionable info
            const t = buildTrendText("รายจ่าย", expense, prevExpense);
            if (t) parts.push(t);
        }
    }

    if (topCat && topCat.pct >= 1) {
        parts.push(`หมวดที่ใช้เยอะสุดคือ "${topCat.name}" (${topCat.pct}%)`);
    }

    if (parts.length === 0) {
        box.classList.add("hidden");
        return;
    }

    box.classList.remove("hidden");
    textEl.textContent = parts.join(" • ");
}

function buildTrendText(label, cur, prev) {
    if (prev === undefined || prev === null || Number.isNaN(prev)) return "";
    if (prev === 0) {
        if (cur === 0) return "";
        return `${label}เดือนนี้เพิ่มขึ้นจากเดือนก่อน (เดือนก่อนไม่มี${label})`;
    }
    const diffPct = Math.round(((cur - prev) / prev) * 100);
    if (diffPct === 0) return `${label}เดือนนี้เท่ากับเดือนที่แล้ว`;
    const arrow = diffPct > 0 ? "เพิ่มขึ้น" : "ลดลง";
    return `${label}เดือนนี้${arrow} ${Math.abs(diffPct)}% จากเดือนที่แล้ว`;
}

function renderWeeklyChart(txs, year, month, filter = "combined") {
    // Build 5 weeks of data
    const weeks = [0,0,0,0,0].map(() => ({ inc: 0, exp: 0 }));
    txs.forEach(tx => {
        const d = new Date(tx.rawDate);
        const weekNum = Math.min(4, Math.floor((d.getDate() - 1) / 7));
        if (tx.amount > 0) weeks[weekNum].inc += tx.amount;
        else weeks[weekNum].exp += Math.abs(tx.amount);
    });

    const showInc = filter !== "expenses";
    const showExp = filter !== "incomes";

    const maxVal = Math.max(1, ...weeks.map(w => Math.max(showInc ? w.inc : 0, showExp ? w.exp : 0)));

    const chartBars = document.getElementById("chartBars");
    chartBars.innerHTML = "";

    weeks.forEach((w, i) => {
        const incH = Math.round((w.inc / maxVal) * 100);
        const expH = Math.round((w.exp / maxVal) * 100);
        const col = document.createElement("div");
        col.className = "chart-column";
        col.innerHTML = `
            <div class="bars-pair">
                ${showInc ? `<div class="bar inc" style="height: ${incH}%" title="รายรับ: ${formatCurrency(w.inc)}"></div>` : ""}
                ${showExp ? `<div class="bar exp" style="height: ${expH}%" title="รายจ่าย: ${formatCurrency(w.exp)}"></div>` : ""}
            </div>
            <span class="col-label">สัปดาห์ ${i + 1}</span>
        `;
        chartBars.appendChild(col);
    });

    // Toggle chart legend to match filter
    const legendInc = document.querySelector(".chart-legend .legend-item.inc");
    const legendExp = document.querySelector(".chart-legend .legend-item.exp");
    if (legendInc) legendInc.classList.toggle("hidden", !showInc);
    if (legendExp) legendExp.classList.toggle("hidden", !showExp);

    // Update y-axis labels
    const yLabels = document.querySelectorAll(".chart-y-axis span");
    if (yLabels.length >= 3) {
        yLabels[0].textContent = formatCompact(maxVal);
        yLabels[1].textContent = formatCompact(maxVal / 2);
        yLabels[2].textContent = "0";
    }
}

function renderFamilyCompare(year, month, filter = "combined") {
    const list = document.getElementById("summaryCompareList");
    list.innerHTML = "";

    const users = ["mon", "milk"];
    if (!state.apiData) return;

    users.forEach(u => {
        const info = USER_INFO[u];
        const userData = state.apiData[u];
        if (!userData) return;

        const summaryEntry = getSummaryEntry(year, month);
        let income, expense;
        if (summaryEntry) {
            income  = u === "mon" ? summaryEntry.monIncome  : summaryEntry.milkIncome;
            expense = u === "mon" ? summaryEntry.monExpense : summaryEntry.milkExpense;
        } else {
            const txs = (userData.transactions || []).filter(tx => {
                const d = new Date(tx.rawDate);
                return d.getMonth() === month && d.getFullYear() === year;
            });
            income  = txs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
            expense = txs.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
        }
        const balance = income - expense;

        let headline, headlineCls;
        if (filter === "incomes") { headline = formatCurrency(income); headlineCls = "income"; }
        else if (filter === "expenses") { headline = formatCurrency(expense); headlineCls = "expense"; }
        else { headline = formatCurrency(balance); headlineCls = balance >= 0 ? "income" : "expense"; }

        const li = document.createElement("li");
        li.className = "compare-item";
        li.innerHTML = `
            <div class="compare-avatar ${u}">${info.avatar}</div>
            <div class="compare-info">
                <strong>${info.displayName}</strong>
                <span>รับ ${formatCurrency(income)} / จ่าย ${formatCurrency(expense)}</span>
            </div>
            <div class="compare-balance ${headlineCls}">${headline}</div>
        `;
        list.appendChild(li);
    });
}

function navigateMonth(dir) {
    let { year, month } = state.summaryMonth;
    month += dir;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }
    state.summaryMonth = { year, month };
    renderSummaryPane();
}

// ─── HISTORY PANE ────────────────────────────────────────────────────────────
function renderHistoryPane() {
    if (!state.apiData) return;

    const userData = state.apiData[state.user];
    if (!userData) return;

    let txs = [...(userData.transactions || [])];

    // Apply filter
    if (state.historyFilter === "income") txs = txs.filter(t => t.amount > 0);
    else if (state.historyFilter === "expense") txs = txs.filter(t => t.amount < 0);

    // Apply search
    if (state.historySearch) {
        txs = txs.filter(t => 
            t.item.toLowerCase().includes(state.historySearch) ||
            (t.note || "").toLowerCase().includes(state.historySearch)
        );
    }

    // Sort newest first
    txs.sort((a, b) => b.rawDate - a.rawDate);

    // Group by date
    const groups = {};
    txs.forEach(tx => {
        const d = new Date(tx.rawDate);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!groups[key]) groups[key] = { label: formatDayLabel(d), txs: [] };
        groups[key].txs.push(tx);
    });

    const container = document.getElementById("historyGroupContainer");
    container.innerHTML = "";

    if (Object.keys(groups).length === 0) {
        container.innerHTML = `<div class="tx-empty">ไม่มีรายการที่ตรงกัน</div>`;
        return;
    }

    Object.values(groups).forEach(group => {
        const section = document.createElement("div");
        section.className = "tx-group";

        const dayTotal = group.txs.reduce((s, t) => s + t.amount, 0);
        section.innerHTML = `
            <div class="tx-group-header">
                <span class="group-date">${group.label}</span>
                <span class="group-total ${dayTotal >= 0 ? 'income' : 'expense'}">${dayTotal >= 0 ? '+' : ''}${formatCurrency(dayTotal)}</span>
            </div>
            <ul class="premium-tx-list">${group.txs.map(tx => renderTxItem(tx)).join("")}</ul>
        `;
        container.appendChild(section);
    });

    // Attach click listeners
    container.querySelectorAll(".tx-list-item").forEach(el => {
        el.addEventListener("click", () => openDetailModal(el.dataset.id));
    });
}

function renderTxItem(tx) {
    const isInc = tx.amount > 0;
    const icon = CAT_ICONS[tx.item] || (isInc ? "💰" : "📌");
    const cls = isInc ? "income" : "expense";
    const prefix = isInc ? "+" : "";

    return `
        <li class="tx-list-item" data-id="${tx.id}">
            <div class="tx-icon-wrap ${cls}">${icon}</div>
            <div class="tx-main">
                <span class="tx-name">${tx.item || "รายการ"}</span>
                <span class="tx-sub">${getTxNote(tx) ? getTxNote(tx) + " • " : ""}${formatTimeShort(new Date(tx.rawDate))}</span>
            </div>
            <div class="tx-amt ${cls}">${prefix}${formatCurrency(tx.amount)}</div>
        </li>
    `;
}

// ─── ADD / EDIT TRANSACTION ──────────────────────────────────────────────────
function openAddSheet(type = "expense", txToEdit = null) {
    state.editingTx = txToEdit;

    const form = document.getElementById("transactionForm");
    form.reset();

    // Set type radio
    const typeVal = txToEdit ? (txToEdit.amount > 0 ? "income" : "expense") : type;
    document.querySelectorAll("input[name='formType']").forEach(r => r.checked = r.value === typeVal);
    document.querySelectorAll(".form-type-tab").forEach(tab => {
        tab.classList.toggle("active", tab.querySelector("input").value === typeVal);
    });

    updateCategoryOptions(typeVal);

    // Title
    document.getElementById("formActionTitle").textContent = txToEdit ? "แก้ไขรายการ" : "เพิ่มรายการ";

    if (txToEdit) {
        document.getElementById("formTxId").value = txToEdit.id;
        document.getElementById("formInputAmount").value = Math.abs(txToEdit.amount);
        document.getElementById("formInputCategory").value = txToEdit.item;
        document.getElementById("formInputNote").value = getTxNote(txToEdit);

        // Set datetime
        const d = new Date(txToEdit.rawDate);
        const localStr = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.getElementById("formInputDate").value = localStr;
    } else {
        document.getElementById("formTxId").value = "";
        const now = new Date();
        const localStr = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.getElementById("formInputDate").value = localStr;
    }

    document.getElementById("addTransactionSheet").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeSheet() {
    document.getElementById("addTransactionSheet").classList.remove("open");
    document.body.style.overflow = "";
    state.editingTx = null;
}

function updateCategoryOptions(type) {
    const sel = document.getElementById("formInputCategory");
    const cats = CATEGORIES[type] || CATEGORIES.expense;
    sel.innerHTML = cats.map(c => `<option value="${c}">${CAT_ICONS[c] || ""} ${c}</option>`).join("");
}

async function handleFormSubmit(e) {
    e.preventDefault();

    const amount    = parseFloat(document.getElementById("formInputAmount").value);
    const category  = document.getElementById("formInputCategory").value;
    const note      = document.getElementById("formInputNote").value.trim();
    const dateStr   = document.getElementById("formInputDate").value;
    const typeEl    = document.querySelector("input[name='formType']:checked");
    const txId      = document.getElementById("formTxId").value;

    if (isNaN(amount) || amount <= 0 || !category) return;

    const finalAmt = typeEl.value === "expense" ? -Math.abs(amount) : Math.abs(amount);

    const btn = document.getElementById("btnSubmitForm");
    btn.disabled = true;
    btn.querySelector("span").classList.add("hidden");
    btn.querySelector(".btn-spinner").classList.remove("hidden");

    try {
        const payload = {
            action: txId ? "update" : "add",
            user: state.user,
            item: category,
            note: note,
            amount: finalAmt,
            date: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString()
        };
        if (txId) payload.id = txId;

        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (!result.success) throw new Error(result.error || "ผิดพลาด");

        showToast(txId ? "✅ แก้ไขรายการสำเร็จ!" : "✅ บันทึกรายการสำเร็จ!");
        closeSheet();
        await loadData(true);

    } catch (err) {
        console.error(err);
        showToast("❌ เกิดข้อผิดพลาด: " + err.message);
    } finally {
        btn.disabled = false;
        btn.querySelector("span").classList.remove("hidden");
        btn.querySelector(".btn-spinner").classList.add("hidden");
    }
}

// ─── DETAIL MODAL ────────────────────────────────────────────────────────────
let currentDetailTx = null;

function openDetailModal(txId) {
    if (!state.apiData) return;
    const userData = state.apiData[state.user];
    const tx = (userData?.transactions || []).find(t => t.id === txId);
    if (!tx) return;

    currentDetailTx = tx;

    const isInc = tx.amount > 0;
    const icon  = CAT_ICONS[tx.item] || (isInc ? "💰" : "📌");
    const cls   = isInc ? "income" : "expense";

    document.getElementById("txtDetailIcon").textContent = icon;
    document.getElementById("txtDetailCategoryName").textContent = tx.item;
    document.getElementById("txtDetailAmount").textContent = (isInc ? "+" : "") + formatCurrency(tx.amount);
    document.getElementById("txtDetailAmount").className = cls;
    document.getElementById("txtDetailCategorySub").textContent = tx.item;
    document.getElementById("txtDetailDate").textContent = formatDateLong(new Date(tx.rawDate));
    document.getElementById("txtDetailNote").textContent = getTxNote(tx) || "-";

    document.getElementById("txDetailModal").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeDetailModal() {
    document.getElementById("txDetailModal").classList.remove("open");
    document.body.style.overflow = "";
    currentDetailTx = null;
}

function onEditClick() {
    if (!currentDetailTx) return;
    const tx = currentDetailTx; // เก็บค่าไว้ก่อน เพราะ closeDetailModal() จะเซ็ต currentDetailTx เป็น null
    closeDetailModal();
    openAddSheet(tx.amount > 0 ? "income" : "expense", tx);
}

async function onDeleteClick() {
    if (!currentDetailTx) return;
    const ok = await customConfirm(`ต้องการลบรายการ "${currentDetailTx.item}" ใช่หรือไม่?`, { title: "ลบรายการ", danger: true, confirmText: "ลบรายการ" });
    if (!ok) return;

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ action: "delete", user: state.user, id: currentDetailTx.id })
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || "ผิดพลาด");

        showToast("🗑️ ลบรายการสำเร็จ!");
        closeDetailModal();
        await loadData(true);

    } catch (err) {
        showToast("❌ ลบไม่สำเร็จ: " + err.message);
    }
}

// ─── CATEGORY MANAGER ─────────────────────────────────────────────────────────
let categoryManagerType = "expense";

function openCategoryManager() {
    categoryManagerType = "expense";
    document.querySelectorAll(".cat-type-tab").forEach(t => t.classList.toggle("active", t.dataset.cattype === "expense"));
    renderCategoryManagerList();
    document.getElementById("categoryManagerSheet").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeCategoryManager() {
    document.getElementById("categoryManagerSheet").classList.remove("open");
    document.body.style.overflow = "";
}

function renderCategoryManagerList() {
    const list = document.getElementById("categoryManagerList");
    const cats = CATEGORIES[categoryManagerType] || [];

    list.innerHTML = cats.length === 0
        ? `<li class="tx-empty">ยังไม่มีหมวดหมู่</li>`
        : cats.map(c => `
            <li class="cat-manager-item">
                <span class="cat-manager-icon">${CAT_ICONS[c] || "📌"}</span>
                <span class="cat-manager-name">${c}</span>
                <button class="cat-manager-delete" data-cat="${c}" aria-label="ลบหมวดหมู่ ${c}">✕</button>
            </li>
        `).join("");

    list.querySelectorAll(".cat-manager-delete").forEach(btn => {
        btn.addEventListener("click", () => deleteCategory(btn.dataset.cat));
    });
}

async function deleteCategory(cat) {
    const cats = CATEGORIES[categoryManagerType];
    if (cats.length <= 1) {
        await customAlert("ต้องมีหมวดหมู่อย่างน้อย 1 รายการ", { title: "ลบไม่ได้" });
        return;
    }
    const ok = await customConfirm(`ต้องการลบหมวดหมู่ "${cat}" ใช่หรือไม่?`, { title: "ลบหมวดหมู่", danger: true, confirmText: "ลบ" });
    if (!ok) return;

    CATEGORIES[categoryManagerType] = cats.filter(c => c !== cat);
    saveCategories();
    renderCategoryManagerList();
    showToast("🗑️ ลบหมวดหมู่แล้ว");
}

function addCategoryFromInput() {
    const input = document.getElementById("inputNewCategory");
    const name = input.value.trim();
    if (!name) return;

    if (CATEGORIES[categoryManagerType].includes(name)) {
        showToast("⚠️ มีหมวดหมู่นี้อยู่แล้ว");
        return;
    }

    CATEGORIES[categoryManagerType].push(name);
    saveCategories();
    input.value = "";
    renderCategoryManagerList();
    showToast("✅ เพิ่มหมวดหมู่แล้ว");
}

// ─── GROUP MANAGER (สำหรับกราฟโดนัท) ─────────────────────────────────────────
function openGroupManager() {
    renderGroupManagerList();
    document.getElementById("groupManagerSheet").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeGroupManager() {
    document.getElementById("groupManagerSheet").classList.remove("open");
    document.body.style.overflow = "";
    renderSummaryPane(); // อัพเดตกราฟโดนัทให้ตรงกับกลุ่มล่าสุด
}

function renderGroupManagerList() {
    const container = document.getElementById("groupManagerList");
    const groupNames = Object.keys(customGroups);

    if (groupNames.length === 0) {
        container.innerHTML = `<p class="tx-empty">ยังไม่มีกลุ่ม ลองสร้างกลุ่มแรกด้านล่างได้เลย</p>`;
        return;
    }

    container.innerHTML = groupNames.map(g => `
        <div class="group-card">
            <div class="group-card-header">
                <span class="group-card-name">${CAT_ICONS[g] || "📁"} ${g}</span>
                <button class="group-delete-btn" data-group="${g}" aria-label="ลบกลุ่ม ${g}">✕</button>
            </div>
            <div class="group-chip-list">
                ${(customGroups[g] || []).map(item => `
                    <span class="group-chip">${item}<button class="chip-remove" data-group="${g}" data-item="${item}">✕</button></span>
                `).join("") || `<span class="group-chip-empty">ยังไม่มีรายการในกลุ่มนี้</span>`}
            </div>
            <div class="group-add-item-row">
                <input type="text" class="group-item-input" data-group="${g}" placeholder="เพิ่มรายการ เช่น ข้าว">
                <button class="group-item-add-btn" data-group="${g}">+</button>
            </div>
        </div>
    `).join("");

    container.querySelectorAll(".group-delete-btn").forEach(btn => {
        btn.addEventListener("click", () => deleteGroup(btn.dataset.group));
    });
    container.querySelectorAll(".chip-remove").forEach(btn => {
        btn.addEventListener("click", () => removeItemFromGroup(btn.dataset.group, btn.dataset.item));
    });
    container.querySelectorAll(".group-item-add-btn").forEach(btn => {
        btn.addEventListener("click", () => addItemToGroupFromInput(btn.dataset.group));
    });
    container.querySelectorAll(".group-item-input").forEach(input => {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addItemToGroupFromInput(input.dataset.group); }
        });
    });
}

async function deleteGroup(group) {
    const ok = await customConfirm(`ต้องการลบกลุ่ม "${group}" ใช่หรือไม่? (รายการที่เคยอยู่ในกลุ่มนี้จะกลับไปเดาแบบอัตโนมัติแทน)`, { title: "ลบกลุ่ม", danger: true, confirmText: "ลบ" });
    if (!ok) return;
    delete customGroups[group];
    saveGroups();
    renderGroupManagerList();
    showToast("🗑️ ลบกลุ่มแล้ว");
}

function removeItemFromGroup(group, item) {
    if (!customGroups[group]) return;
    customGroups[group] = customGroups[group].filter(i => i !== item);
    saveGroups();
    renderGroupManagerList();
}

function addItemToGroupFromInput(group) {
    const input = document.querySelector(`.group-item-input[data-group="${CSS.escape(group)}"]`);
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;

    if (!customGroups[group]) customGroups[group] = [];
    if (customGroups[group].some(i => i.toLowerCase() === val.toLowerCase())) {
        showToast("⚠️ มีรายการนี้ในกลุ่มอยู่แล้ว");
        return;
    }

    customGroups[group].push(val);
    saveGroups();
    renderGroupManagerList();
}

function addGroupFromInput() {
    const input = document.getElementById("inputNewGroup");
    const name = input.value.trim();
    if (!name) return;

    if (customGroups[name]) {
        showToast("⚠️ มีกลุ่มนี้อยู่แล้ว");
        return;
    }

    customGroups[name] = [];
    saveGroups();
    input.value = "";
    renderGroupManagerList();
}

// ─── QUICK CLASSIFY (จัดหมวดหมู่ด่วนสำหรับรายการที่ยังไม่เข้ากลุ่ม) ────────────
let lastUnclassifiedItems = []; // [{ item, amount }] ของเดือน/filter ที่ render ล่าสุด
let lastUnclassifiedIsIncome = false;

function renderUnclassifiedBanner() {
    const banner = document.getElementById("unclassifiedBanner");
    const textEl = document.getElementById("unclassifiedBannerText");
    if (!banner || !textEl) return;

    if (lastUnclassifiedItems.length === 0) {
        banner.classList.add("hidden");
        return;
    }

    banner.classList.remove("hidden");
    textEl.textContent = `มี ${lastUnclassifiedItems.length} รายการยังไม่จัดหมวดหมู่`;
}

function openQuickClassify() {
    renderQuickClassifyList();
    document.getElementById("quickClassifySheet").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeQuickClassify() {
    document.getElementById("quickClassifySheet").classList.remove("open");
    document.body.style.overflow = "";
    renderSummaryPane(); // อัพเดตกราฟโดนัท/banner ให้ตรงกับการจัดหมวดหมู่ล่าสุด
}

function renderQuickClassifyList() {
    const container = document.getElementById("quickClassifyList");
    const groupNames = Object.keys(customGroups);

    if (lastUnclassifiedItems.length === 0) {
        container.innerHTML = `<p class="tx-empty">🎉 จัดหมวดหมู่ครบหมดแล้ว ไม่มีรายการค้าง</p>`;
        return;
    }

    container.innerHTML = lastUnclassifiedItems.map(({ item, amount }) => `
        <div class="qc-item" data-item="${item}">
            <div class="qc-item-head">
                <span class="qc-item-name">${item}</span>
                <span class="qc-item-amount">${formatCurrency(amount)}</span>
            </div>
            <div class="qc-chip-row">
                ${groupNames.map(g => `<button class="qc-chip" data-item="${item}" data-group="${g}">${CAT_ICONS[g] || "📁"} ${g}</button>`).join("")}
                <button class="qc-chip qc-chip-new" data-item="${item}">+ กลุ่มใหม่</button>
            </div>
        </div>
    `).join("");

    container.querySelectorAll(".qc-chip:not(.qc-chip-new)").forEach(btn => {
        btn.addEventListener("click", () => assignQuickItem(btn.dataset.item, btn.dataset.group));
    });
    container.querySelectorAll(".qc-chip-new").forEach(btn => {
        btn.addEventListener("click", () => assignQuickItemToNewGroup(btn.dataset.item));
    });
}

function assignQuickItem(item, group) {
    if (!customGroups[group]) customGroups[group] = [];
    if (!customGroups[group].some(i => i.toLowerCase() === item.toLowerCase())) {
        customGroups[group].push(item);
        saveGroups();
    }
    lastUnclassifiedItems = lastUnclassifiedItems.filter(x => x.item !== item);
    renderUnclassifiedBanner();
    renderQuickClassifyList();
    showToast(`✅ "${item}" → ${group}`);
}

async function assignQuickItemToNewGroup(item) {
    const name = await customPrompt(`ตั้งชื่อกลุ่มใหม่สำหรับ "${item}" (เช่น อาหาร)`, "", { title: "สร้างกลุ่มใหม่" });
    if (!name || !name.trim()) return;
    const groupName = name.trim();
    if (!customGroups[groupName]) customGroups[groupName] = [];
    assignQuickItem(item, groupName);
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
async function logout() {
    const ok = await customConfirm("ต้องการออกจากระบบและเปลี่ยนบัญชีใช่หรือไม่?", { title: "ออกจากระบบ", danger: true, confirmText: "ออกจากระบบ" });
    if (!ok) return;
    localStorage.removeItem("budget_user");
    state.user = null;
    state.apiData = null;
    document.getElementById("appLayout").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
    document.body.className = "";
}

async function editBudget() {
    const newBudget = await customPrompt("ตั้งงบประมาณรายเดือน (บาท):", state.budget, { title: "งบประมาณรายเดือน" });
    if (newBudget === null) return;
    const val = parseFloat(newBudget);
    if (isNaN(val) || val < 0) { await customAlert("กรุณากรอกตัวเลขที่ถูกต้อง"); return; }
    state.budget = val;
    localStorage.setItem("budget_amount", val.toString());
    document.getElementById("txtSettingBudget").textContent = formatCurrency(val) + "/เดือน";
    showToast("✅ บันทึกงบประมาณแล้ว!");
    renderHomePane();
}

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        showToast("⚠️ เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");
        return;
    }

    if (Notification.permission === "granted") {
        showToast("🔔 เปิดการแจ้งเตือนอยู่แล้ว");
        scheduleReminders();
        return;
    }

    if (Notification.permission === "denied") {
        await customAlert("การแจ้งเตือนถูกบล็อกไว้ กรุณาไปเปิดสิทธิ์การแจ้งเตือนของเว็บไซต์นี้ในตั้งค่าเบราว์เซอร์ด้วยตนเอง", { title: "แจ้งเตือนถูกบล็อก" });
        return;
    }

    const perm = await Notification.requestPermission();
    updateNotifyBadge();

    if (perm === "granted") {
        showToast("✅ เปิดการแจ้งเตือนสำเร็จ!");
        new Notification("เปิดการแจ้งเตือนแล้ว 🎉", { body: "เราจะเตือนให้คุณบันทึกรายรับ-รายจ่ายทุกวัน" });
        scheduleReminders();
    } else {
        showToast("❌ คุณไม่ได้อนุญาตการแจ้งเตือน");
    }
}

function updateNotifyBadge() {
    const badge = document.querySelector("#btnNotify .notify-badge");
    if (!badge) return;
    const granted = ("Notification" in window) && Notification.permission === "granted";
    badge.classList.toggle("hidden", granted); // ซ่อนจุดแดงถ้าเปิดแจ้งเตือนแล้ว
}

// ตั้งตัวจับเวลาเช็คทุก 30 วินาทีว่าถึงเวลาแจ้งเตือนหรือยัง
// หมายเหตุ: นี่คือการแจ้งเตือนแบบ "ขณะเปิดแอปอยู่" เท่านั้น เพราะเว็บนี้ยังไม่มี
// Service Worker + Push server ฝั่ง backend การแจ้งเตือนจริงแบบพื้นหลัง (ปิดแอปแล้วยังเตือน)
// ต้องเพิ่มระบบ Web Push ฝั่งเซิร์ฟเวอร์เพิ่มเติม
let reminderIntervalId = null;

function scheduleReminders() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (reminderIntervalId) clearInterval(reminderIntervalId);
    checkReminders();
    reminderIntervalId = setInterval(checkReminders, 30000);
}

function checkReminders() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const now = new Date();
    const hh = now.getHours().toString().padStart(2, "0");
    const mm = now.getMinutes().toString().padStart(2, "0");
    const hm = `${hh}:${mm}`;

    if (!REMINDER_TIMES.includes(hm)) return;

    const fireKey = now.toISOString().slice(0, 10) + "_" + hm; // กันยิงซ้ำในนาทีเดียวกัน
    if (localStorage.getItem("reminder_last_fired") === fireKey) return;
    localStorage.setItem("reminder_last_fired", fireKey);

    new Notification("อย่าลืมบันทึกรายรับ-รายจ่ายน้า 💰", {
        body: "แตะเพื่อเปิดแอปแล้วบันทึกรายการของวันนี้กันเถอะ"
    });
}

// ─── LOADING / TOAST ─────────────────────────────────────────────────────────
let loadingProgressInterval = null;
let loadingStatusInterval = null;
let loadingCurrentPct = 0;

function startLoadingScreen() {
    const screen = document.getElementById("appLoadingScreen");
    const fill = document.getElementById("appLoadingProgressFill");
    const pctEl = document.getElementById("appLoadingPercent");
    const statusEl = document.getElementById("appLoadingStatus");
    const retryBtn = document.getElementById("btnLoadingRetry");
    if (!screen) return;

    loadingCurrentPct = 0;
    fill.style.width = "0%";
    pctEl.textContent = "0%";
    statusEl.textContent = LOADING_STATUS_MESSAGES[0];
    retryBtn.classList.add("hidden");
    screen.classList.remove("hidden", "error");

    // จำลองแถบโหลดแบบไต่ขึ้นเรื่อยๆ (ช้าลงเรื่อยๆ) ค้างสูงสุดที่ 90% จนกว่าข้อมูลจะมาจริง
    // เพราะเวลารอส่วนใหญ่คือ Apps Script ประมวลผลฝั่งเซิร์ฟเวอร์ ไม่ใช่ดาวน์โหลดไฟล์ วัด progress จริงไม่ได้
    clearInterval(loadingProgressInterval);
    loadingProgressInterval = setInterval(() => {
        const remaining = 90 - loadingCurrentPct;
        loadingCurrentPct += Math.max(0.3, remaining * 0.06);
        if (loadingCurrentPct > 90) loadingCurrentPct = 90;
        fill.style.width = loadingCurrentPct.toFixed(0) + "%";
        pctEl.textContent = loadingCurrentPct.toFixed(0) + "%";
    }, 200);

    // สลับข้อความสถานะทุก ๆ 3 วิ ให้รู้สึกว่ายังทำงานอยู่ ไม่ใช่ค้าง
    let statusIdx = 0;
    clearInterval(loadingStatusInterval);
    loadingStatusInterval = setInterval(() => {
        statusIdx = (statusIdx + 1) % LOADING_STATUS_MESSAGES.length;
        statusEl.textContent = LOADING_STATUS_MESSAGES[statusIdx];
    }, 3000);
}

function finishLoadingScreen(success, errorMsg) {
    clearInterval(loadingProgressInterval);
    clearInterval(loadingStatusInterval);

    const screen = document.getElementById("appLoadingScreen");
    const fill = document.getElementById("appLoadingProgressFill");
    const pctEl = document.getElementById("appLoadingPercent");
    const statusEl = document.getElementById("appLoadingStatus");
    const retryBtn = document.getElementById("btnLoadingRetry");
    if (!screen) return;

    if (success) {
        fill.style.width = "100%";
        pctEl.textContent = "100%";
        statusEl.textContent = "เสร็จแล้ว!";
        setTimeout(() => screen.classList.add("hidden"), 350);
    } else {
        screen.classList.add("error");
        statusEl.textContent = errorMsg || "โหลดข้อมูลไม่สำเร็จ";
        retryBtn.classList.remove("hidden");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const retryBtn = document.getElementById("btnLoadingRetry");
    if (retryBtn) retryBtn.addEventListener("click", () => loadData(true));
});

// ─── CUSTOM DIALOG (replaces native confirm/prompt/alert - unreliable in WebView) ──
function showDialog({ title = "แจ้งเตือน", message = "", showInput = false, inputValue = "", showCancel = true, confirmText = "ตกลง", danger = false }) {
    return new Promise((resolve) => {
        const overlay = document.getElementById("customDialogOverlay");
        const titleEl = document.getElementById("dialogTitle");
        const msgEl = document.getElementById("dialogMessage");
        const inputEl = document.getElementById("dialogInput");
        const cancelBtn = document.getElementById("dialogCancelBtn");
        const confirmBtn = document.getElementById("dialogConfirmBtn");

        titleEl.textContent = title;
        msgEl.textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.classList.toggle("danger", danger);
        cancelBtn.classList.toggle("hidden", !showCancel);

        if (showInput) {
            inputEl.classList.remove("hidden");
            inputEl.value = inputValue;
        } else {
            inputEl.classList.add("hidden");
        }

        const cleanup = (result) => {
            overlay.classList.remove("open");
            cancelBtn.removeEventListener("click", onCancel);
            confirmBtn.removeEventListener("click", onConfirm);
            inputEl.removeEventListener("keydown", onKeydown);
            resolve(result);
        };

        const onCancel = () => cleanup(showInput ? null : false);
        const onConfirm = () => cleanup(showInput ? inputEl.value : true);
        const onKeydown = (e) => { if (e.key === "Enter") onConfirm(); };

        cancelBtn.addEventListener("click", onCancel);
        confirmBtn.addEventListener("click", onConfirm);
        inputEl.addEventListener("keydown", onKeydown);

        overlay.classList.add("open");
        if (showInput) setTimeout(() => inputEl.focus(), 100);
    });
}

function customConfirm(message, opts = {}) {
    return showDialog({ title: opts.title || "ยืนยันการทำรายการ", message, showCancel: true, confirmText: opts.confirmText || "ตกลง", danger: !!opts.danger });
}

function customPrompt(message, defaultValue = "", opts = {}) {
    return showDialog({ title: opts.title || "กรอกข้อมูล", message, showInput: true, inputValue: defaultValue, showCancel: true, confirmText: opts.confirmText || "บันทึก" });
}

function customAlert(message, opts = {}) {
    return showDialog({ title: opts.title || "แจ้งเตือน", message, showCancel: false, confirmText: "ตกลง" });
}

function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.remove("hidden");
    toast.classList.add("show");
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.classList.add("hidden"), 300);
    }, 2500);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// กันเหนียวกรณี backend (Google Sheets) ใช้ชื่อคอลัมน์โน้ตต่างจาก "note"
function getTxNote(tx) {
    if (!tx) return "";
    return tx.note || tx.Note || tx.memo || tx.Memo || tx.remark || tx.Remark || tx.detail || tx.Detail || "";
}

// ─── FORMATTERS ─────────────────────────────────────────────────────────────
function formatCurrency(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return "฿0.00";
    const abs = Math.abs(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? "-฿" : "฿") + abs;
}

function formatCompact(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return Math.round(n).toString();
}

function formatDayLabel(d) {
    const thDays   = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
    const thMonths = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

    const isSameDay = (a, b) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();

    if (isSameDay(d, today)) return "วันนี้";
    if (isSameDay(d, yesterday)) return "เมื่อวาน";
    return `${thDays[d.getDay()]}ที่ ${d.getDate()} ${thMonths[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function formatTimeShort(d) {
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m} น.`;
}

function formatDateLong(d) {
    const thMonths = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                      "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${d.getDate()} ${thMonths[d.getMonth()]} ${d.getFullYear() + 543} ${h}:${m}`;
}
