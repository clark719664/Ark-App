/* Ark Web Solutions — interactions. No dependencies. */
(function () {
  var docEl = document.documentElement;
  docEl.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Sticky nav: elevate on scroll */
  var topbar = document.querySelector('.topbar');
  var onScroll = function () {
    topbar.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* Mobile menu */
  var menuBtn = document.querySelector('.menu-btn');
  var nav = document.querySelector('.topnav');
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () {
      var open = topbar.classList.toggle('nav-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        topbar.classList.remove('nav-open');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* Scroll-reveal with stagger */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    revealEls.forEach(function (el) { io.observe(el); });

    /* Stagger siblings inside marked groups */
    document.querySelectorAll('[data-stagger]').forEach(function (group) {
      Array.prototype.forEach.call(group.children, function (child, i) {
        child.style.transitionDelay = (i * 90) + 'ms';
      });
    });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in-view'); });
  }

  /* Animated counters in the stats strip */
  var counters = document.querySelectorAll('[data-count]');
  var animateCount = function (el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var decimals = (el.getAttribute('data-count').split('.')[1] || '').length;
    var suffix = el.getAttribute('data-suffix') || '';
    var duration = 1400;
    var start = null;
    var step = function (ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if ('IntersectionObserver' in window && !reduceMotion) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animateCount(entry.target);
          cio.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { cio.observe(el); });
  } else {
    counters.forEach(function (el) {
      el.textContent = el.getAttribute('data-count') + (el.getAttribute('data-suffix') || '');
    });
  }

  /* Active section highlighting in the nav */
  var sections = document.querySelectorAll('main section[id]');
  var navLinks = document.querySelectorAll('.topnav a[href^="#"]');
  if ('IntersectionObserver' in window && sections.length) {
    var sio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          navLinks.forEach(function (a) {
            a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
          });
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (s) { sio.observe(s); });
  }

  /* Smooth FAQ open/close */
  document.querySelectorAll('details').forEach(function (d) {
    var content = d.querySelector('p');
    if (!content) return;
    d.querySelector('summary').addEventListener('click', function (e) {
      if (reduceMotion) return;
      e.preventDefault();
      if (d.open) {
        content.style.maxHeight = '0';
        content.style.opacity = '0';
        setTimeout(function () { d.open = false; }, 240);
      } else {
        d.open = true;
        content.style.maxHeight = '0';
        content.style.opacity = '0';
        requestAnimationFrame(function () {
          content.style.maxHeight = content.scrollHeight + 'px';
          content.style.opacity = '1';
        });
      }
    });
  });
})();
