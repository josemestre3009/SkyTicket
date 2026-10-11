/* global document, window */
(function () {
  'use strict';

  // Progressive enhancement: HTML ships with .no-js so the nav works without
  // JavaScript; removing it here opts the document into the JS drawer.
  document.documentElement.classList.remove('no-js');

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    setupNav();
    setupAutoSubmit();
    setupConfirm();
    setupLoading();
    setupCopy();
    setupReveal();
    setupPasswordToggle();
    setupIssuePackages();
  });

  function setupIssuePackages() {
    var site = document.querySelector('[data-issue-site]');
    var choices = document.querySelectorAll('[data-package-site]');
    var empty = document.querySelector('[data-package-empty]');
    if (!site || !choices.length) return;

    function update() {
      var selected = site.value;
      var visible = 0;
      choices.forEach(function (choice) {
        var match = Boolean(selected) && choice.getAttribute('data-package-site') === selected;
        choice.hidden = !match;
        var radio = choice.querySelector('input[type="radio"]');
        if (radio) {
          radio.disabled = !match;
          if (!match) radio.checked = false;
        }
        if (match) visible += 1;
      });
      if (empty) empty.hidden = !selected || visible > 0;
    }

    site.addEventListener('change', update);
    update();
  }

  function setupPasswordToggle() {
    document.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('aria-controls');
        var input = id ? document.getElementById(id) : null;
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.textContent = show ? 'Ocultar' : 'Mostrar';
      });
    });
  }

  // Accessible off-canvas drawer: aria-expanded, scrim click, Escape, focus
  // management/trap, body scroll lock, close on nav click and desktop resize.
  function setupNav() {
    var toggles = document.querySelectorAll('[data-nav-toggle]');
    var nav = document.querySelector('[data-nav]');
    var scrim = document.querySelector('[data-nav-scrim]');
    if (!toggles.length || !nav) return;

    var desktop = window.matchMedia('(min-width: 1024px)');
    var lastFocused = null;

    function open() {
      return nav.classList.contains('is-open');
    }

    function setOpen(next) {
      nav.classList.toggle('is-open', next);
      if (scrim) {
        scrim.classList.toggle('is-open', next);
        scrim.hidden = !next;
      }
      document.body.classList.toggle('nav-open', next);
      toggles.forEach(function (toggle) {
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        var label = toggle.querySelector('[data-nav-label]');
        if (label) label.textContent = next ? 'Cerrar menú' : 'Abrir menú';
      });
      if (next) {
        lastFocused = document.activeElement;
        document.addEventListener('keydown', onKeydown, true);
        var first = nav.querySelector('a[href], button:not([disabled])');
        if (first) first.focus();
      } else {
        document.removeEventListener('keydown', onKeydown, true);
        if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
        lastFocused = null;
      }
    }

    function close() {
      if (open()) setOpen(false);
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      var items = nav.querySelectorAll('a[href], button:not([disabled])');
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    toggles.forEach(function (toggle) {
      toggle.addEventListener('click', function () {
        setOpen(!open());
      });
    });
    if (scrim) scrim.addEventListener('click', close);
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a[href]')) close();
    });
    var onMediaChange = function (event) {
      if (event.matches) close();
    };
    if (desktop.addEventListener) desktop.addEventListener('change', onMediaChange);
    else desktop.addListener(onMediaChange);
  }

  function setupAutoSubmit() {
    document.querySelectorAll('[data-auto-submit]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (el.form) el.form.submit();
      });
    });
  }

  // Replaces inline onsubmit handlers (blocked by the self-only CSP) with a
  // same-origin listener that keeps the confirmation behaviour.
  function setupConfirm() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        var message = form.getAttribute('data-confirm') || '¿Confirmar acción?';
        if (!window.confirm(message)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      });
    });
  }

  function setupLoading() {
    document.querySelectorAll('form').forEach(function (form) {
      form.addEventListener('submit', function () {
        form.querySelectorAll('[data-loading]').forEach(function (btn) {
          btn.classList.add('is-loading');
          btn.setAttribute('aria-busy', 'true');
          if (btn.tagName === 'BUTTON' && btn.type === 'submit') btn.disabled = true;
        });
      });
    });
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('clipboard_unavailable'));
  }

  function setupCopy() {
    document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        writeClipboard(btn.getAttribute('data-copy-target') || '').catch(function () {});
      });
    });
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = btn.closest('.voucher-list__item');
        var target = item ? item.querySelector('[data-code]') : null;
        if (target) writeClipboard(target.textContent.trim()).catch(function () {});
      });
    });
  }

  function setupReveal() {
    var scope = document.querySelector('[data-reveal-scope]');
    if (!scope) return;
    var csrf = scope.getAttribute('data-csrf') || '';
    scope.querySelectorAll('[data-reveal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var url = btn.getAttribute('data-url');
        var item = btn.closest('.voucher-list__item');
        var codeEl = item ? item.querySelector('[data-code]') : null;
        btn.classList.add('is-loading');
        btn.disabled = true;
        fetch(url, { method: 'POST', headers: { 'x-csrf-token': csrf, accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('reveal_failed');
            return res.json();
          })
          .then(function (data) {
            if (codeEl && data.code) codeEl.textContent = data.code;
            var copyBtn = item ? item.querySelector('[data-copy]') : null;
            if (copyBtn) copyBtn.disabled = false;
          })
          .catch(function () {})
          .finally(function () {
            btn.classList.remove('is-loading');
            btn.disabled = false;
          });
      });
    });
  }
})();
