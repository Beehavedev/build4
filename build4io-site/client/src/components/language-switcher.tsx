import { useI18n, LANGUAGE_LABELS, type Language } from "@/lib/i18n";

const languages: Language[] = ["en", "zh", "es"];

export function LanguageSwitcher() {
  const { lang, setLang } = useI18n();

  return (
    <div className="flex items-center gap-0.5 font-mono text-xs" data-testid="language-switcher">
      {languages.map((l, i) => (
        <span key={l} className="flex items-center gap-0.5">
          {i > 0 && <span className="text-border mx-0.5">/</span>}
          <button
            onClick={() => setLang(l)}
            className={`px-1 py-0.5 rounded-md transition-colors ${
              lang === l
                ? "text-primary font-semibold"
                : "text-muted-foreground hover-elevate"
            }`}
            data-testid={`button-lang-${l}`}
          >
            {LANGUAGE_LABELS[l]}
          </button>
        </span>
      ))}
    </div>
  );
}
