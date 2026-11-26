import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import tr from "./tr.json";

const STORAGE_KEY = "yocto-studio.lang";

export function syncNativeLanguage(lang: "tr" | "en"): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return invoke("set_app_language", { lang }).then(
      () => undefined,
      () => undefined
    );
  }
  return Promise.resolve();
}

function getInitialLanguage(): "tr" | "en" {
  try {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved === "en" || saved === "tr") {
      return saved;
    }
  } catch {
    // ignore storage errors in restricted environments
  }
  return "tr";
}

const initialLang = getInitialLanguage();
if (typeof document !== "undefined") {
  document.documentElement.lang = initialLang;
}
void syncNativeLanguage(initialLang);

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      tr: { translation: tr },
      en: { translation: en },
    },
    lng: initialLang,
    fallbackLng: "tr",
    interpolation: {
      escapeValue: false,
    },
  });
}

export function setAppLanguage(lang: "tr" | "en"): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, lang);
    }
  } catch {
    // ignore
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void syncNativeLanguage(lang).finally(() => {
      void i18next.changeLanguage(lang);
    });
  } else {
    void i18next.changeLanguage(lang);
  }
}

export default i18next;
