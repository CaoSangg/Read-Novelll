/* Homepage interactions translated from src/app/page.tsx; no auth or storage. */
(() => {
  "use strict";
  const registryKey = Symbol.for("read-novel.home");
  window[registryKey]?.destroy();
  let disposePage = null;

  function mount() {
    if (disposePage) return;
    const stage = document.getElementById("home-stage");
    if (!stage) return;
    const controller = new AbortController();
    const { signal } = controller;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const overlays = [...document.querySelectorAll(".modal-overlay")];
    let current = null;
    let returnFocus = null;
    let previousOverflow = "";
    let scrollPosition = null;
    let closeTimer = null;
    let openFrame = null;

    function finishClose(restoreFocus = true) {
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      if (openFrame !== null) window.cancelAnimationFrame(openFrame);
      closeTimer = openFrame = null;
      if (!current) return;
      current.classList.remove("active");
      current.hidden = true;
      current = null;
      stage.inert = false;
      document.body.style.overflow = previousOverflow;
      if (scrollPosition) window.scrollTo(...scrollPosition);
      if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = scrollPosition = null;
    }

    function closeModal() {
      if (!current || closeTimer !== null) return;
      if (openFrame !== null) window.cancelAnimationFrame(openFrame);
      openFrame = null;
      current.classList.remove("active");
      // Keep the focus trap and scroll lock during the fade, then restore both.
      if (motion.matches) finishClose();
      else closeTimer = window.setTimeout(finishClose, 300);
    }

    function openModal(trigger) {
      const overlay = overlays.find((item) => item.id === trigger.getAttribute("aria-controls"));
      if (!overlay) return;
      finishClose(false);
      returnFocus = trigger;
      previousOverflow = document.body.style.overflow;
      scrollPosition = [window.scrollX, window.scrollY];
      document.body.style.overflow = "hidden";
      stage.inert = true;
      current = overlay;
      current.hidden = false;
      // Commit the initial opacity before starting the source's 300ms fade.
      void current.offsetWidth;
      current.querySelector(".modal-x").focus({ preventScroll: true });
      openFrame = window.requestAnimationFrame(() => {
        current?.classList.add("active");
        openFrame = null;
      });
    }

    document.querySelectorAll("[data-modal-open]").forEach((trigger) => {
      trigger.addEventListener("click", () => openModal(trigger), { signal });
    });
    overlays.forEach((overlay) => {
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-modal-close]")) closeModal();
      }, { signal });
    });
    document.addEventListener("keydown", (event) => {
      if (!current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      } else if (event.key === "Tab") {
        const buttons = [...current.querySelectorAll("button:not([disabled])")];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }, { signal });
    document.addEventListener("focusin", (event) => {
      if (current && !current.contains(event.target)) current.querySelector(".modal-x").focus();
    }, { signal });

    const disposeParticles = startParticles(document.getElementById("particles-canvas"), motion, signal);
    disposePage = () => {
      finishClose(false);
      disposeParticles();
      controller.abort();
    };
  }

  function startParticles(canvas, motion, signal) {
    let ctx = null;
    try { ctx = canvas?.getContext("2d"); } catch { /* Modals still work without Canvas. */ }
    if (!ctx) return () => {};
    let width = 0;
    let height = 0;
    let frame = null;
    let lastTime = null;
    const particles = [];

    function reset(particle) {
      Object.assign(particle, {
        x: Math.random() * width, y: Math.random() * height,
        size: Math.random() * 2 + 0.5,
        speedX: (Math.random() - 0.5) * 0.3,
        speedY: -Math.random() * 0.4 - 0.1,
        opacity: Math.random() * 0.5 + 0.1,
        color: Math.random() > 0.4 ? "255, 215, 0" : "220, 240, 255",
      });
    }

    function draw(step = 0) {
      ctx.clearRect(0, 0, width, height);
      particles.forEach((particle) => {
        particle.x += particle.speedX * step;
        particle.y += particle.speedY * step;
        if (particle.y < 0 || particle.x < 0 || particle.x > width) {
          reset(particle);
          particle.y = height;
        }
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${particle.color}, ${particle.opacity})`;
        ctx.fill();
      });
    }

    function stop() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = lastTime = null;
    }

    function animate(time) {
      frame = null;
      // Source speed is per 60Hz frame. Preserve it on high-refresh displays.
      const step = lastTime === null ? 1 : Math.min(2, (time - lastTime) / (1000 / 60));
      lastTime = time;
      draw(step);
      frame = window.requestAnimationFrame(animate);
    }

    function updatePlayback() {
      stop();
      if (document.hidden) return;
      if (motion.matches) draw(); // Retain the particle appearance without motion.
      else frame = window.requestAnimationFrame(animate);
    }

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      // Cap DPR to limit the full-stage buffer on high-DPI mobile devices.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles.forEach(reset);
      draw();
      updatePlayback();
    }

    for (let i = 0; i < 45; i++) particles.push({});
    window.addEventListener("resize", resize, { signal, passive: true });
    document.addEventListener("visibilitychange", updatePlayback, { signal });
    motion.addEventListener("change", updatePlayback, { signal });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas.parentElement);
    resize();
    return () => { stop(); observer?.disconnect(); particles.length = 0; };
  }

  function unmount() {
    disposePage?.();
    disposePage = null;
  }
  window.addEventListener("pagehide", unmount);
  window.addEventListener("pageshow", mount); // Restore correctly from back/forward cache.
  window[registryKey] = {
    destroy() {
      unmount();
      window.removeEventListener("pagehide", unmount);
      window.removeEventListener("pageshow", mount);
      delete window[registryKey];
    },
  };
  mount();
})();
