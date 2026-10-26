import { getAnalytics, isSupported } from "firebase/analytics";
import { app } from "./firebase-config.js";

isSupported().then((supported) => {
  if (supported) getAnalytics(app);
}).catch(() => {});
