import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Language = "en" | "zh" | "es";

interface I18nContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string) => any;
}

const I18nContext = createContext<I18nContextType>({
  lang: "en",
  setLang: () => {},
  t: (key: string) => key,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function useLang() {
  const { lang } = useContext(I18nContext);
  return lang;
}

export function useT() {
  const { t } = useContext(I18nContext);
  return t;
}

function getNestedValue(obj: Record<string, any>, path: string): any {
  const keys = path.split(".");
  let current: any = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return path;
    current = current[key];
  }
  if (typeof current === "string" || Array.isArray(current)) return current;
  return path;
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "EN",
  zh: "中文",
  es: "ES",
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("build4-lang");
      if (stored === "zh" || stored === "es" || stored === "en") return stored;
    }
    return "en";
  });

  const [translations, setTranslations] = useState<Record<string, any>>({});

  useEffect(() => {
    localStorage.setItem("build4-lang", lang);
    if (lang === "en") {
      import("@/i18n/en").then((m) => setTranslations(m.default));
    } else if (lang === "zh") {
      import("@/i18n/zh").then((m) => setTranslations(m.default));
    } else if (lang === "es") {
      import("@/i18n/es").then((m) => setTranslations(m.default));
    }
  }, [lang]);

  const setLang = (newLang: Language) => {
    setLangState(newLang);
  };

  const t = (key: string): any => {
    return getNestedValue(translations, key);
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}
