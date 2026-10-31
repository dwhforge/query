(() => {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  /* —— Header / nav —— */
  const header = document.querySelector(".site-header");
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".nav");

  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("is-solid", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* —— Cursor spotlight —— */
  const spot = document.createElement("div");
  spot.className = "cursor-spot";
  spot.setAttribute("aria-hidden", "true");
  document.body.appendChild(spot);

  let spotX = window.innerWidth / 2;
  let spotY = window.innerHeight * 0.25;
  let targetX = spotX;
  let targetY = spotY;

  if (!reduceMotion) {
    window.addEventListener(
      "pointermove",
      (e) => {
        targetX = e.clientX;
        targetY = e.clientY;
        document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
        document.documentElement.style.setProperty("--my", `${e.clientY}px`);
      },
      { passive: true },
    );

    const tickSpot = () => {
      spotX += (targetX - spotX) * 0.12;
      spotY += (targetY - spotY) * 0.12;
      spot.style.transform = `translate3d(${spotX}px, ${spotY}px, 0)`;
      requestAnimationFrame(tickSpot);
    };
    requestAnimationFrame(tickSpot);
  }

  /* —— Graph canvas (data-node field) —— */
  const atmosphere = document.querySelector(".atmosphere");
  if (atmosphere && !reduceMotion) {
    const canvas = document.createElement("canvas");
    canvas.className = "fx-canvas";
    canvas.setAttribute("aria-hidden", "true");
    atmosphere.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let w = 0;
    let h = 0;
    let dpr = 1;
    const nodes = [];
    const NODE_COUNT = 48;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seed() {
      nodes.length = 0;
      for (let i = 0; i < NODE_COUNT; i++) {
        nodes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35,
          vy: (Math.random() - 0.5) * 0.35,
          r: 1.2 + Math.random() * 1.8,
          pulse: Math.random() * Math.PI * 2,
        });
      }
    }

    resize();
    seed();
    window.addEventListener("resize", () => {
      resize();
      seed();
    });

    let raf = 0;
    function frame(t) {
      raf = requestAnimationFrame(frame);
      ctx.clearRect(0, 0, w, h);

      const mx = targetX;
      const my = targetY;

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;

        const dx = mx - n.x;
        const dy = my - n.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 180) {
          n.vx -= (dx / dist) * 0.008;
          n.vy -= (dy / dist) * 0.008;
        }
        const speed = Math.hypot(n.vx, n.vy);
        if (speed > 0.55) {
          n.vx *= 0.98;
          n.vy *= 0.98;
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < 140) {
            const alpha = (1 - d / 140) * 0.22;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(45, 212, 191, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      for (const n of nodes) {
        const glow = 0.45 + 0.35 * Math.sin(t * 0.002 + n.pulse);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(45, 212, 191, ${0.35 + glow * 0.35})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 3.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(45, 212, 191, ${0.04 + glow * 0.05})`;
        ctx.fill();
      }
    }
    raf = requestAnimationFrame(frame);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(frame);
    });
  }

  /* —— Hero brand letter split (DWHForge / Query) —— */
  const brand = document.querySelector(".hero-brand");
  if (brand && !reduceMotion) {
    const wrapLetters = (el, className, indexOffset) => {
      const text = el.textContent;
      el.textContent = "";
      [...text].forEach((ch, i) => {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = ch === " " ? "\u00a0" : ch;
        span.style.setProperty("--i", String(i + (indexOffset || 0)));
        el.appendChild(span);
      });
    };
    const stem = brand.querySelector(".brand-stem");
    const query = brand.querySelector(".query");
    if (stem) wrapLetters(stem, "char", 0);
    if (query) wrapLetters(query, "char char-teal", 8);
    brand.classList.add("is-split");
  }

  /* —— 3D tilt + shine on hero stage —— */
  const stage = document.querySelector(".hero-stage");
  if (stage && !reduceMotion) {
    const frame = stage.querySelector(".hero-frame") || stage;
    let rx = 0;
    let ry = 0;
    let trx = 0;
    let try_ = 0;

    stage.addEventListener("pointermove", (e) => {
      const rect = stage.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      trx = py * -8;
      try_ = px * 10;
      stage.style.setProperty("--shine-x", `${(px + 0.5) * 100}%`);
      stage.style.setProperty("--shine-y", `${(py + 0.5) * 100}%`);
    });
    stage.addEventListener("pointerleave", () => {
      trx = 0;
      try_ = 0;
    });

    const tiltLoop = () => {
      rx += (trx - rx) * 0.08;
      ry += (try_ - ry) * 0.08;
      frame.style.transform = `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(0)`;
      requestAnimationFrame(tiltLoop);
    };
    requestAnimationFrame(tiltLoop);
  }

  /* —— Magnetic buttons —— */
  if (!reduceMotion) {
    document.querySelectorAll(".btn-primary, .nav-cta").forEach((btn) => {
      btn.addEventListener("pointermove", (e) => {
        const r = btn.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2;
        const y = e.clientY - r.top - r.height / 2;
        btn.style.transform = `translate(${x * 0.18}px, ${y * 0.22}px)`;
      });
      btn.addEventListener("pointerleave", () => {
        btn.style.transform = "";
      });
    });
  }

  /* —— Feature shots (any image size; optional data-full for the expanded file) —— */
  const shotButtons = document.querySelectorAll(".feature-shot");
  if (shotButtons.length && "HTMLDialogElement" in window) {
    const dialog = document.createElement("dialog");
    dialog.className = "shot-lightbox";
    dialog.innerHTML = [
      '<div class="shot-stage">',
      '<div class="shot-glow" aria-hidden="true"></div>',
      '<div class="shot-frame">',
      "<img alt=\"\" />",
      '<div class="shot-scan" aria-hidden="true"></div>',
      '<button type="button" class="shot-close">Close</button>',
      "</div>",
      '<p class="shot-caption"></p>',
      "</div>",
    ].join("");
    document.body.appendChild(dialog);

    const frame = dialog.querySelector(".shot-frame");
    const frameImg = frame.querySelector("img");
    const caption = dialog.querySelector(".shot-caption");
    const closeBtn = dialog.querySelector(".shot-close");
    let opener = null;

    const revealShot = () => {
      if (reduceMotion) dialog.classList.add("is-in");
      else requestAnimationFrame(() => dialog.classList.add("is-in"));
    };

    const openShot = (btn) => {
      const img = btn.querySelector("img");
      if (!img) return;
      const full = img.getAttribute("data-full") || img.currentSrc || img.src;
      opener = btn;
      caption.textContent = img.alt || "";
      frameImg.alt = img.alt || "";
      dialog.classList.remove("is-in");
      frameImg.onload = () => revealShot();
      frameImg.src = full;
      if (!dialog.open) dialog.showModal();
      if (frameImg.complete) revealShot();
    };

    shotButtons.forEach((btn) => {
      btn.setAttribute("aria-haspopup", "dialog");
      btn.addEventListener("click", () => openShot(btn));
    });

    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      dialog.close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.classList.remove("is-in");
      frameImg.removeAttribute("src");
      frameImg.onload = null;
      if (opener) {
        opener.focus();
        opener = null;
      }
    });
  }

  /* —— Scroll reveals —— */
  const revealEls = document.querySelectorAll(
    ".feature-list li, .steps li, .section-head, .download-panel, .demo-points li, .doc-links li, .matrix, [data-reveal]",
  );
  if (revealEls.length && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    revealEls.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.setProperty("--reveal-delay", `${(i % 6) * 70}ms`);
      io.observe(el);
    });
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* —— Scroll progress bar —— */
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.appendChild(bar);

  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? window.scrollY / max : 0;
    bar.style.transform = `scaleX(${p})`;
  };
  updateProgress();
  window.addEventListener("scroll", updateProgress, { passive: true });

  /* —— Parallax orbs follow scroll —— */
  const orbs = document.querySelectorAll(".orb");
  if (orbs.length && !reduceMotion) {
    window.addEventListener(
      "scroll",
      () => {
        const y = window.scrollY;
        orbs.forEach((orb, i) => {
          const factor = 0.04 + i * 0.025;
          orb.style.transform = `translate3d(0, ${y * factor}px, 0)`;
        });
      },
      { passive: true },
    );
  }

  /* —— Downloads —— */
  const RELEASES_API =
    "https://api.github.com/repos/dwhforge/query/releases/latest";
  const RELEASES_PAGE = "https://github.com/dwhforge/query/releases";

  function pick(assets, re) {
    return assets.find((a) => re.test(a.name));
  }

  function mountDownloads(root) {
    if (!root) return;
    const status = root.querySelector("[data-release-status]");
    const actions = root.querySelector("[data-release-actions]");
    if (!status || !actions) return;

    status.textContent = "Loading latest release…";

    fetch(RELEASES_API)
      .then((r) => {
        if (!r.ok) throw new Error("No release yet");
        return r.json();
      })
      .then((rel) => {
        const assets = rel.assets || [];
        const linux =
          pick(assets, /electron-linux-x64\.tar\.gz$/i) ||
          pick(assets, /linux-x86_64\.tar\.gz$/i);
        const win =
          pick(assets, /electron-windows-x64\.zip$/i) ||
          pick(assets, /windows-x86_64\.zip$/i);

        status.innerHTML = `Latest: <strong>${rel.tag_name}</strong>`;

        const bits = [];
        if (linux) {
          bits.push(
            `<a class="btn btn-primary" href="${linux.browser_download_url}">Linux x86_64</a>`,
          );
        }
        if (win) {
          bits.push(
            `<a class="btn btn-primary" href="${win.browser_download_url}">Windows x86_64</a>`,
          );
        }
        bits.push(
          `<a class="btn btn-ghost" href="${rel.html_url}">All assets on GitHub</a>`,
        );

        if (!linux && !win) {
          status.innerHTML = `<strong>${rel.tag_name}</strong> — binaries still uploading, or open GitHub.`;
        }
        actions.innerHTML = bits.join("");

        if (!reduceMotion) {
          actions.querySelectorAll(".btn-primary").forEach((btn) => {
            btn.addEventListener("pointermove", (e) => {
              const r = btn.getBoundingClientRect();
              const x = e.clientX - r.left - r.width / 2;
              const y = e.clientY - r.top - r.height / 2;
              btn.style.transform = `translate(${x * 0.18}px, ${y * 0.22}px)`;
            });
            btn.addEventListener("pointerleave", () => {
              btn.style.transform = "";
            });
          });
        }
      })
      .catch(() => {
        status.textContent = "No published release yet.";
        actions.innerHTML = `<a class="btn btn-primary" href="${RELEASES_PAGE}">Open releases</a>`;
      });
  }

  document.querySelectorAll("[data-download-panel]").forEach(mountDownloads);
})();
