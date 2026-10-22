import { useState, useEffect } from "react";

export type ThemeMode = 'light' | 'dark' | 'system';
export function readThemeMode(): ThemeMode {
  const value = localStorage.getItem('theme');
  return value === 'light' || value === 'dark' ? value : 'system';
}
function applyTheme(mode: ThemeMode) {
  const resolved = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-color-mode', resolved);
  document.documentElement.style.colorScheme = resolved;
  window.dispatchEvent(new Event('colorSchemeChange'));
}
export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem('theme', mode);
  applyTheme(mode);
}

export function listenSystemMode() {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function darkModeHandler() {
    if (readThemeMode() === 'system') applyTheme('system');
  }

  // 判断当前模式
  applyTheme(readThemeMode());
  // 监听模式变化
  mediaQuery.addEventListener("change", darkModeHandler);
}

export function getCurrentColorMode(): "light" | "dark" {
  return (
    (document.documentElement.getAttribute("data-color-mode") as
      | "light"
      | "dark") || "light"
  );
}

export function useColorMode() {
  const [colorMode, setColorMode] = useState<"light" | "dark">(
    getCurrentColorMode()
  );

  useEffect(() => {
    const updateColorMode = () => {
      setColorMode(getCurrentColorMode());
    };

    // 初始设置
    updateColorMode();

    // 监听颜色模式变化事件
    window.addEventListener("colorSchemeChange", updateColorMode);

    // 清理函数
    return () => {
      window.removeEventListener("colorSchemeChange", updateColorMode);
    };
  }, []);

  return colorMode;
}
