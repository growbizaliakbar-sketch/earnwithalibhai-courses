// Earn With Ali Bhai — front-end niceties (no build step).
// - Mobile nav toggle + scrim
// - Admin sidebar toggle
// - IntersectionObserver reveal-on-scroll
// - FAQ / curriculum accordion
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  // ----- Mobile nav -----
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  var scrim = document.getElementById('navScrim');
  function closeNav() {
    if (!links) return;
    links.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (scrim) scrim.classList.remove('show');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      document.body.classList.toggle('nav-open', open);
      if (scrim) scrim.classList.toggle('show', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    if (scrim) scrim.addEventListener('click', closeNav);
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeNav();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav();
    });
  }

  // ----- Admin sidebar (mobile) -----
  var adminToggle = document.getElementById('adminToggle');
  if (adminToggle) {
    adminToggle.addEventListener('click', function () {
      document.body.classList.toggle('admin-nav-open');
    });
  }

  // ----- Student sidebar (mobile) -----
  var studentToggle = document.getElementById('studentToggle');
  if (studentToggle) {
    studentToggle.addEventListener('click', function () {
      document.body.classList.toggle('student-nav-open');
    });
  }

  // ----- Reveal on scroll -----
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  // ----- Accordion (FAQ + curriculum) -----
  document.querySelectorAll('.faq-item').forEach(function (item) {
    var btn = item.querySelector('.faq-q');
    var panel = item.querySelector('.faq-a');
    if (!btn || !panel) return;
    btn.addEventListener('click', function () {
      var isOpen = item.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(isOpen));
      panel.style.maxHeight = isOpen ? panel.scrollHeight + 'px' : '0px';
    });
  });

  // ----- Lesson player niceties: remember position -----
  var video = document.getElementById('lessonVideo');
  if (video) {
    var key = 'eabh-pos-' + video.getAttribute('src');
    try {
      var saved = parseFloat(localStorage.getItem(key));
      if (!isNaN(saved) && saved > 5) {
        video.addEventListener('loadedmetadata', function () {
          if (saved < video.duration - 5) video.currentTime = saved;
        }, { once: true });
      }
      video.addEventListener('timeupdate', function () {
        if (!video.paused) localStorage.setItem(key, String(video.currentTime));
      });
      video.addEventListener('ended', function () {
        try { localStorage.removeItem(key); } catch (_) {}
      });
    } catch (_) {}
  }
})();
