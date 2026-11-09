import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import playground from "./locales/en/playground";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: { playground },
  },
  interpolation: { escapeValue: false },
});

export default i18n;
