import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAiVpljQvXQPPdKcOwNt5KCrLczO0vX00w",
  authDomain: "whatsapp-software-a85f3.firebaseapp.com",
  projectId: "whatsapp-software-a85f3",
  storageBucket: "whatsapp-software-a85f3.firebasestorage.app",
  messagingSenderId: "301311258779",
  appId: "1:301311258779:web:2f92fc1980afb75fa9d63e",
  measurementId: "G-K9L08TYL1F"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, "default");

export { app, db };
