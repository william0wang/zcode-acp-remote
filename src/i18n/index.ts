import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { loadLang } from "../lib/storage";
import en from "./en.json";
import zhCN from "./zh-CN.json";

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: loadLang(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
