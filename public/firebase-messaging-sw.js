/* Firebase Cloud Messaging worker — Automichat admin notifications. */
importScripts("https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAiVpljQvXQPPdKcOwNt5KCrLczO0vX00w",
  authDomain: "whatsapp-software-a85f3.firebaseapp.com",
  projectId: "whatsapp-software-a85f3",
  storageBucket: "whatsapp-software-a85f3.firebasestorage.app",
  messagingSenderId: "301311258779",
  appId: "1:301311258779:web:2f92fc1980afb75fa9d63e"
});

firebase.messaging();
