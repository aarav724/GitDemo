(function () {
  function applySavedTheme() {
    const isLight = localStorage.getItem("campusconnect-theme") === "light";
    document.body.classList.toggle("light", isLight);
    document.querySelectorAll("#themeToggle").forEach(button => {
      if (button.dataset.themeBound) return;
      button.textContent = isLight ? "☾" : "☀";
      button.setAttribute("aria-label", isLight ? "Switch to dark mode" : "Switch to light mode");
    });
  }

  applySavedTheme();
  document.addEventListener("click", event => {
    const button = event.target.closest("#themeToggle");
    if (!button) return;
    if (button.dataset.localThemeHandler) return;
    localStorage.setItem("campusconnect-theme", document.body.classList.contains("light") ? "dark" : "light");
    applySavedTheme();
  });
  document.querySelectorAll("#themeToggle").forEach(button => { button.dataset.themeBound = "true"; });
  window.addEventListener("storage", event => {
    if (event.key === "campusconnect-theme") applySavedTheme();
  });
})();
