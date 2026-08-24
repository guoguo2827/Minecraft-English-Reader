(() => {
  const body = document.body;
  const course = body.dataset.mobileCourse;
  if (!course) return;

  const mobileQuery = window.matchMedia("(max-width: 760px) and (orientation: portrait)");
  const sidebar = document.querySelector("#themeTabs");
  const backdrop = document.querySelector("[data-mobile-backdrop]");
  const themeTriggers = document.querySelectorAll("[data-mobile-theme-trigger]");
  const menuTriggers = document.querySelectorAll("[data-mobile-menu-trigger]");
  const mobileVoiceButtons = document.querySelectorAll("[data-mobile-voice-target]");
  let learningScrollY = 0;
  let progressByTheme = new Map();

  function closeOverlays() {
    body.classList.remove("mobile-theme-open", "mobile-menu-open", "mobile-overlay-open");
    themeTriggers.forEach((button) => button.setAttribute("aria-expanded", "false"));
    menuTriggers.forEach((button) => button.setAttribute("aria-expanded", "false"));
  }

  function openOverlay(name) {
    const themeOpen = name === "theme" && !body.classList.contains("mobile-theme-open");
    const menuOpen = name === "menu" && !body.classList.contains("mobile-menu-open");
    closeOverlays();
    if (themeOpen) {
      body.classList.add("mobile-theme-open", "mobile-overlay-open");
      themeTriggers.forEach((button) => button.setAttribute("aria-expanded", "true"));
    }
    if (menuOpen) {
      body.classList.add("mobile-menu-open", "mobile-overlay-open");
      menuTriggers.forEach((button) => button.setAttribute("aria-expanded", "true"));
    }
  }

  themeTriggers.forEach((button) => button.addEventListener("click", () => openOverlay("theme")));
  menuTriggers.forEach((button) => button.addEventListener("click", () => openOverlay("menu")));
  backdrop?.addEventListener("click", closeOverlays);
  sidebar?.addEventListener("click", (event) => {
    if (event.target.closest("[data-theme]")) closeOverlays();
  });

  mobileVoiceButtons.forEach((button) => {
    const target = document.querySelector(button.dataset.mobileVoiceTarget);
    if (!target) return;
    const sync = () => {
      const status = target.textContent.trim();
      button.setAttribute("aria-label", status || button.textContent.trim());
      button.title = status;
    };
    new MutationObserver(sync).observe(target, { childList: true, characterData: true, subtree: true });
    sync();
    button.addEventListener("click", () => target.click());
  });

  document.querySelectorAll(".mobile-learning-nav [data-mode-button]").forEach((button) => {
    button.addEventListener("click", () => {
      closeOverlays();
      if (button.dataset.modeButton === "quiz") {
        learningScrollY = window.scrollY;
      } else {
        window.setTimeout(() => window.scrollTo({ top: learningScrollY, behavior: "smooth" }), 80);
      }
    });
  });

  function annotateThemeButtons() {
    sidebar?.querySelectorAll("[data-theme]").forEach((button) => {
      const summary = progressByTheme.get(String(button.dataset.themeId))
        || progressByTheme.get(Number(button.dataset.theme));
      button.querySelector(".mobile-theme-progress")?.remove();
      if (!summary) return;
      const label = document.createElement("span");
      label.className = "mobile-theme-progress";
      label.textContent = course === "chinese"
        ? `${summary.completion}% complete · ${summary.masteredWords}/${summary.totalWords}`
        : `完成 ${summary.completion}% · ${summary.masteredWords}/${summary.totalWords}`;
      button.querySelector(".tab-title")?.appendChild(label);
    });
  }

  async function loadThemeProgress() {
    try {
      const endpoint = course === "chinese" ? "/api/chinese/progress" : "/api/progress";
      const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      progressByTheme = new Map();
      (data.themes || []).forEach((theme, index) => {
        progressByTheme.set(index, theme);
        if (theme.id != null) progressByTheme.set(String(theme.id), theme);
      });
      annotateThemeButtons();
    } catch {}
  }

  if (sidebar) {
    new MutationObserver(annotateThemeButtons).observe(sidebar, { childList: true });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOverlays();
  });

  const handleViewportChange = () => {
    if (!mobileQuery.matches) closeOverlays();
  };
  mobileQuery.addEventListener?.("change", handleViewportChange);
  window.addEventListener("pageshow", handleViewportChange);
  loadThemeProgress();
})();
