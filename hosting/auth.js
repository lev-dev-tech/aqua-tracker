/* Custom Firebase email-action handler for Aqua (verify email / reset password).
   Set this page as the "action URL" in Firebase Console → Authentication → Templates.
   Firebase appends ?mode=...&oobCode=...&apiKey=...&lang=... to this URL. */
(function () {
  var APP_URL = 'https://lev-dev-tech.github.io/aqua-tracker/';
  var CONFIG = {
    apiKey: 'AIzaSyB0KnzzPbdBoaxWQT_a4r30hukU6_aqMVQ',
    authDomain: 'aqua-tracker-8f261.firebaseapp.com',
    projectId: 'aqua-tracker-8f261',
    appId: '1:664109561589:web:4aaf71fe54165b176d77bc',
  };
  var $ = function (s) { return document.querySelector(s); };
  var qs = new URLSearchParams(location.search);
  var mode = qs.get('mode');
  var code = qs.get('oobCode');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // state: 'loading' | 'ok' | 'error'
  function render(state, title, msg, formHtml) {
    var card = $('#card');
    card.classList.remove('is-loading', 'is-ok', 'is-error');
    card.classList.add('is-' + state);
    var glyph = state === 'ok' ? '<svg viewBox="0 0 24 24" class="g-svg"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
      : state === 'error' ? '<svg viewBox="0 0 24 24" class="g-svg"><path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="9"/></svg>'
      : '<span class="spinner"></span>';
    $('#glyph').innerHTML = glyph;
    $('#title').textContent = title || '';
    $('#msg').innerHTML = msg || '';
    $('#form').innerHTML = formHtml || '';
    $('#openApp').hidden = state === 'loading';
  }

  function fail(title, msg) { render('error', title || 'Что-то пошло не так', msg || 'Ссылка устарела или уже использована. Запроси новое письмо в приложении.'); }

  if (typeof firebase === 'undefined' || !firebase.initializeApp) {
    return fail('Не удалось загрузить', 'Проверь интернет и открой ссылку из письма ещё раз.');
  }
  try { firebase.initializeApp(CONFIG); } catch (e) {}
  var auth = firebase.auth();

  if (!mode || !code) { return fail('Ссылка недействительна', 'Кажется, ссылка неполная. Открой её из письма целиком.'); }

  if (mode === 'verifyEmail') {
    auth.applyActionCode(code)
      .then(function () { render('ok', 'Почта подтверждена', 'Готово! Возвращайся в приложение — статус обновится сам.'); })
      .catch(function () { fail('Не удалось подтвердить', 'Ссылка устарела или уже использована. Открой приложение и запроси письмо ещё раз.'); });
  } else if (mode === 'recoverEmail') {
    auth.applyActionCode(code)
      .then(function () { render('ok', 'Адрес восстановлен', 'Прежняя почта возвращена. Можешь снова войти в приложении.'); })
      .catch(function () { fail('Не удалось', 'Ссылка устарела.'); });
  } else if (mode === 'resetPassword') {
    auth.verifyPasswordResetCode(code)
      .then(function (email) { showReset(email); })
      .catch(function () { fail('Ссылка устарела', 'Запроси сброс пароля заново в приложении.'); });
  } else {
    fail('Неизвестное действие', 'Открой приложение и попробуй снова.');
  }

  function showReset(email) {
    render('loading', 'Новый пароль', 'Для аккаунта <b>' + esc(email) + '</b>',
      '<div class="field"><input type="password" id="np" placeholder="Новый пароль (мин. 6)" autocomplete="new-password"></div>' +
      '<div class="field"><input type="password" id="np2" placeholder="Повтори пароль" autocomplete="new-password"></div>' +
      '<div class="err" id="rerr"></div>' +
      '<button class="btn primary" id="doReset">Сохранить пароль</button>');
    $('#card').classList.remove('is-loading');   // show the form, not the spinner
    $('#glyph').innerHTML = '<svg viewBox="0 0 24 24" class="g-svg"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
    $('#openApp').hidden = false;
    var btn = $('#doReset'), err = $('#rerr');
    btn.onclick = function () {
      err.textContent = '';
      var p1 = $('#np').value, p2 = $('#np2').value;
      if (!p1 || p1.length < 6) { err.textContent = 'Минимум 6 символов'; return; }
      if (p1 !== p2) { err.textContent = 'Пароли не совпадают'; return; }
      btn.disabled = true; btn.textContent = 'Сохраняю…';
      auth.confirmPasswordReset(code, p1)
        .then(function () { render('ok', 'Пароль изменён', 'Готово! Войди в приложении с новым паролем.'); })
        .catch(function () { btn.disabled = false; btn.textContent = 'Сохранить пароль'; err.textContent = 'Ссылка устарела — запроси сброс заново.'; });
    };
    $('#np').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#np2').focus(); });
    $('#np2').addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
  }

  $('#openApp').onclick = function () { location.href = APP_URL; };
})();
