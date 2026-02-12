// Simple reveal-on-scroll
(function(){
  const els = Array.from(document.querySelectorAll(".reveal"));
  if (els.length === 0) return;

  if (!("IntersectionObserver" in window)) {
    els.forEach(el => el.classList.add("is-visible"));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.15 });

  els.forEach(el => io.observe(el));
})();
