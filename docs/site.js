// EN/TR switch shared by index.html and privacy.html. Saved choice wins,
// otherwise the browser language decides.
(function () {
  var root = document.documentElement;
  var btns = document.querySelectorAll('[data-set-lang]');

  function setLang(lang) {
    root.classList.toggle('lang-tr', lang === 'tr');
    root.lang = lang;
    btns.forEach(function (b) {
      var on = b.getAttribute('data-set-lang') === lang;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      var lang = b.getAttribute('data-set-lang');
      setLang(lang);
      try {
        localStorage.setItem('hindsight-lang', lang);
      } catch (e) {
        /* storage blocked; the choice lasts for this page only */
      }
    });
  });

  var saved = null;
  try {
    saved = localStorage.getItem('hindsight-lang');
  } catch (e) {}
  if (saved !== 'en' && saved !== 'tr') {
    var nav = (navigator.language || 'en').toLowerCase();
    saved = nav.indexOf('tr') === 0 ? 'tr' : 'en';
  }
  setLang(saved);
})();
