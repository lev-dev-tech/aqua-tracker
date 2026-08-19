/* Firebase init — runs after the SDK scripts, before app.js. Exposes window.FB.
   The web config (apiKey etc.) is public by design; access is guarded by Firestore
   security rules. If the SDK failed to load (rare), the app stays local-only. */
(function () {
  if (typeof firebase === 'undefined' || !firebase.initializeApp) return;
  try {
    firebase.initializeApp({
      apiKey: 'AIzaSyB0KnzzPbdBoaxWQT_a4r30hukU6_aqMVQ',
      authDomain: 'aqua-tracker-8f261.firebaseapp.com',
      projectId: 'aqua-tracker-8f261',
      storageBucket: 'aqua-tracker-8f261.firebasestorage.app',
      messagingSenderId: '664109561589',
      appId: '1:664109561589:web:4aaf71fe54165b176d77bc',
    });
    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});
    window.FB = { auth: firebase.auth(), db: firebase.firestore() };
  } catch (e) { console.warn('firebase init failed', e); }
})();
