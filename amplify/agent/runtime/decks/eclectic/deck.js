/* ==========================================================================
   deckdeck — a tiny vanilla-JS presentation engine
   Renders the 折衷 技術スライド集 slides at a fixed 1920×1080 design size,
   scaled to fit any viewport, with keyboard/click navigation, deep-linking,
   a speaker-notes drawer, an overview grid and a shortcut cheatsheet.
   ========================================================================== */
(function () {
  'use strict';

  var DESIGN_W = 1920;
  var DESIGN_H = 1080;

  var scaler   = document.getElementById('stage-scaler');
  var stageEl  = document.getElementById('stage');
  var slides   = Array.prototype.slice.call(document.querySelectorAll('.deck-slide'));
  var total    = slides.length;

  var counter    = document.getElementById('counter');
  var labelEl    = document.getElementById('slide-label');
  var progressEl = document.getElementById('progress-bar');

  var notesEl      = document.getElementById('notes');
  var notesNum     = document.getElementById('notes-num');
  var notesLabel   = document.getElementById('notes-label');
  var notesBody    = document.getElementById('notes-body');

  var overviewEl   = document.getElementById('overview');
  var overviewGrid = document.getElementById('overview-grid');
  var helpEl       = document.getElementById('help');

  var current      = 0;
  var notesOpen    = false;
  var overviewOpen = false;
  var helpOpen     = false;
  var overviewBuilt = false;
  var lastFocus    = null;   // element focused before an overlay opened

  /* --- focus management for modal overlays ------------------------------ */
  function focusInto(panel) {
    lastFocus = document.activeElement;
    var f = panel.querySelector('button, [href], input, select, textarea, [tabindex]');
    if (f && f.focus) f.focus();
    else if (panel.focus) panel.focus();
  }
  function restoreFocus() {
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* --- helpers ---------------------------------------------------------- */
  function clamp(i) { return Math.max(0, Math.min(total - 1, i)); }

  function meta(i) {
    var slide = slides[i];
    var s = slide ? slide.querySelector('section') : null;
    return {
      label: (s && s.dataset.label) || '',
      notes: (s && s.dataset.speakerNotes) || ''
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* --- fit the 1920×1080 stage into the viewport ------------------------ */
  function fit() {
    var s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    scaler.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
  }

  /* --- show a slide ----------------------------------------------------- */
  function show(i, skipHash) {
    current = clamp(i);
    for (var k = 0; k < slides.length; k++) {
      slides[k].classList.toggle('active', k === current);
    }
    var m = meta(current);
    counter.textContent = (current + 1) + ' / ' + total;
    labelEl.textContent = m.label;
    progressEl.style.width = ((current + 1) / total * 100) + '%';

    // keep the notes drawer in sync if it is open
    notesNum.textContent = pad2(current + 1);
    notesLabel.textContent = m.label;
    notesBody.textContent = m.notes || '（スピーカーノートはありません）';

    if (overviewBuilt) updateOverviewActive();

    if (!skipHash) {
      var target = '#' + (current + 1);
      if (location.hash !== target) {
        history.replaceState(null, '', target);
      }
    }
  }

  function next() { if (current < total - 1) show(current + 1); }
  function prev() { if (current > 0) show(current - 1); }
  function first() { show(0); }
  function last() { show(total - 1); }

  /* --- speaker notes ---------------------------------------------------- */
  function openNotes() {
    notesOpen = true;
    notesEl.hidden = false;
    show(current); // refresh contents
    focusInto(notesEl);
  }
  function closeNotes() { notesOpen = false; notesEl.hidden = true; restoreFocus(); }
  function toggleNotes() { notesOpen ? closeNotes() : openNotes(); }

  /* --- overview grid ---------------------------------------------------- */
  function buildOverview() {
    overviewGrid.innerHTML = '';
    slides.forEach(function (wrap, i) {
      var m = meta(i);
      var cell = document.createElement('button');
      cell.className = 'ov-cell';
      cell.dataset.index = i;

      var frame = document.createElement('div');
      frame.className = 'ov-frame';

      var stage = document.createElement('div');
      stage.className = 'ov-stage';
      var section = wrap.querySelector('section');
      if (section) {
        // Strip ids from the clone so SVG marker ids (fwAh, outAh, …) are not
        // duplicated in the DOM. The originals stay on the live slides, so the
        // clone's url(#id) references still resolve to a valid marker.
        var clone = section.cloneNode(true);
        var withId = clone.querySelectorAll('[id]');
        for (var j = 0; j < withId.length; j++) withId[j].removeAttribute('id');
        stage.appendChild(clone);
      }
      frame.appendChild(stage);

      var cap = document.createElement('div');
      cap.className = 'ov-cap';
      var num = document.createElement('span');
      num.className = 'mono';
      num.textContent = pad2(i + 1);
      var txt = document.createElement('span');
      txt.textContent = m.label;
      cap.appendChild(num);
      cap.appendChild(txt);

      cell.appendChild(frame);
      cell.appendChild(cap);
      cell.addEventListener('click', function () {
        show(i);
        closeOverview();
      });
      overviewGrid.appendChild(cell);
    });
    overviewBuilt = true;
    scaleThumbs();
    updateOverviewActive();
  }

  function scaleThumbs() {
    var frames = overviewGrid.querySelectorAll('.ov-frame');
    for (var i = 0; i < frames.length; i++) {
      var w = frames[i].clientWidth;
      var st = frames[i].querySelector('.ov-stage');
      if (st && w) st.style.transform = 'scale(' + (w / DESIGN_W) + ')';
    }
  }

  function updateOverviewActive() {
    var cells = overviewGrid.querySelectorAll('.ov-cell');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('active', Number(cells[i].dataset.index) === current);
    }
  }

  function openOverview() {
    if (!overviewBuilt) buildOverview();
    overviewOpen = true;
    overviewEl.hidden = false;
    scaleThumbs();
    updateOverviewActive();
    var active = overviewGrid.querySelector('.ov-cell.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    focusInto(overviewEl);
  }
  function closeOverview() { overviewOpen = false; overviewEl.hidden = true; restoreFocus(); }
  function toggleOverview() { overviewOpen ? closeOverview() : openOverview(); }

  /* --- help ------------------------------------------------------------- */
  function openHelp() { helpOpen = true; helpEl.hidden = false; focusInto(helpEl); }
  function closeHelp() { helpOpen = false; helpEl.hidden = true; restoreFocus(); }
  function toggleHelp() { helpOpen ? closeHelp() : openHelp(); }

  /* --- fullscreen ------------------------------------------------------- */
  function toggleFullscreen() {
    var d = document;
    if (!d.fullscreenElement) {
      var el = document.getElementById('deck');
      if (el.requestFullscreen) el.requestFullscreen();
    } else if (d.exitFullscreen) {
      d.exitFullscreen();
    }
  }

  /* --- initial slide from ?slide=N or #N -------------------------------- */
  function initialIndex() {
    var q = new URLSearchParams(location.search).get('slide');
    var n = q ? parseInt(q, 10) : NaN;
    if (isNaN(n)) {
      var h = location.hash.replace('#', '');
      n = parseInt(h, 10);
    }
    if (isNaN(n)) n = 1;
    return clamp(n - 1);
  }

  /* --- keyboard --------------------------------------------------------- */
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Let a focused control (HUD button, link, field) use its native keys —
    // e.g. Space/Enter to activate a button. Escape is still handled globally
    // so overlays can always be dismissed.
    var tag = (e.target && e.target.tagName) || '';
    if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(tag) && e.key !== 'Escape') return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
      case 'Spacebar':
        e.preventDefault(); next(); break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault(); prev(); break;
      case 'ArrowDown':
        e.preventDefault(); next(); break;
      case 'ArrowUp':
        e.preventDefault(); prev(); break;
      case 'Home':
        e.preventDefault(); first(); break;
      case 'End':
        e.preventDefault(); last(); break;
      case 'o': case 'O':
        e.preventDefault(); toggleOverview(); break;
      case 'n': case 'N': case 's': case 'S':
        e.preventDefault(); toggleNotes(); break;
      case 'f': case 'F':
        e.preventDefault(); toggleFullscreen(); break;
      case '?':
        e.preventDefault(); toggleHelp(); break;
      case 'Escape':
        if (helpOpen) closeHelp();
        else if (overviewOpen) closeOverview();
        else if (notesOpen) closeNotes();
        break;
      default:
        // numeric jump: type a number then it maps to that slide (1-based)
        if (/^[0-9]$/.test(e.key)) {
          var n = parseInt(e.key, 10);
          if (n >= 1 && n <= total) show(n - 1);
        }
    }
  });

  /* --- click / tap to advance ------------------------------------------- */
  stageEl.addEventListener('click', function (e) {
    if (overviewOpen || helpOpen) return;
    // ignore text selections
    if (window.getSelection && String(window.getSelection())) return;
    if (e.clientX < window.innerWidth * 0.33) prev();
    else next();
  });

  /* --- HUD buttons ------------------------------------------------------ */
  document.getElementById('btn-prev').addEventListener('click', function (e) { e.stopPropagation(); prev(); });
  document.getElementById('btn-next').addEventListener('click', function (e) { e.stopPropagation(); next(); });
  document.getElementById('btn-overview').addEventListener('click', function (e) { e.stopPropagation(); toggleOverview(); });
  document.getElementById('btn-notes').addEventListener('click', function (e) { e.stopPropagation(); toggleNotes(); });
  document.getElementById('btn-full').addEventListener('click', function (e) { e.stopPropagation(); toggleFullscreen(); });
  document.getElementById('btn-help').addEventListener('click', function (e) { e.stopPropagation(); toggleHelp(); });
  document.getElementById('btn-notes-close').addEventListener('click', function (e) { e.stopPropagation(); closeNotes(); });
  document.getElementById('btn-overview-close').addEventListener('click', function (e) { e.stopPropagation(); closeOverview(); });
  document.getElementById('btn-help-close').addEventListener('click', function (e) { e.stopPropagation(); closeHelp(); });
  helpEl.addEventListener('click', function (e) { if (e.target === helpEl) closeHelp(); });

  /* --- browser back/forward on the hash --------------------------------- */
  window.addEventListener('hashchange', function () {
    var raw = location.hash.replace('#', '');
    var h = raw ? parseInt(raw, 10) : 1;   // empty hash → back to the first slide
    if (!isNaN(h) && (h - 1) !== current) show(h - 1, true);
  });

  /* --- resize ----------------------------------------------------------- */
  window.addEventListener('resize', function () {
    fit();
    if (overviewOpen) scaleThumbs();
  });

  /* --- idle cursor / HUD hiding ----------------------------------------- */
  var idleTimer;
  function activity() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!overviewOpen && !helpOpen) document.body.classList.add('idle');
    }, 3000);
  }
  window.addEventListener('mousemove', activity);
  window.addEventListener('keydown', activity);

  /* --- boot ------------------------------------------------------------- */
  fit();
  show(initialIndex(), true);
  activity();
})();
