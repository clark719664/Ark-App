/* Client-site interactions. No dependencies. */
(function () {
  document.documentElement.classList.add('js');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var topbar = document.querySelector('.topbar');
  var onScroll = function () {
    topbar.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

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

    document.querySelectorAll('[data-stagger]').forEach(function (group) {
      Array.prototype.forEach.call(group.children, function (child, i) {
        child.style.transitionDelay = (i * 80) + 'ms';
      });
    });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in-view'); });
  }
})();
