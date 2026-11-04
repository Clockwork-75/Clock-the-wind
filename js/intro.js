// Animated launch intro: the Clockwork logo assembles letter by letter, the orange rolls in,
// the wind-up key winds, then "Clock the Wind" sweeps in on gusts of wind. Tap/click/any key skips.
const LOGO = 'img/clockwork-logo.png';
const ASPECT = 2400 / 619;
// slice boundaries as fractions of logo width: C L O C K W O R K | head | key
const CUTS = [0, 232, 352, 458, 565, 690, 855, 985, 1118, 1280, 1600].map(x => x / 1600);
const KEY = [1508, 1600].map(x => x / 1600); // wind-up key, animated on its own

export function playIntro({ force = false } = {}) {
  let enabled = true;
  try { enabled = localStorage.getItem('ctw.intro') !== 'off'; } catch { /* storage blocked */ }
  if (!enabled && !force) return Promise.resolve();
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.id = 'intro';
    root.innerHTML = `
      <div class="intro-stage">
        <div class="intro-logo"></div>
        <div class="intro-wind">${Array.from({ length: 7 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
        <div class="intro-title"><span>Clock</span> <em>the</em> <span>Wind</span></div>
        <div class="intro-sub">weather routing · Jadran</div>
      </div>
      <div class="intro-skip">dodirni za preskok</div>`;
    const logo = root.querySelector('.intro-logo');
    logo.style.setProperty('--aspect', ASPECT);
    const slices = CUTS.slice(0, -1).map((l, i) => [l, CUTS[i + 1], i < 9 ? 'letter' : 'head']).concat([[KEY[0], KEY[1], 'key']]);
    slices.forEach(([l, r, kind], i) => {
      const s = document.createElement('div');
      s.className = 'intro-slice ' + kind;
      s.style.left = (l * 100) + '%';
      s.style.width = ((r - l) * 100) + '%';
      s.style.backgroundImage = `url(${LOGO})`;
      s.style.backgroundSize = `${100 / (r - l)}% 100%`;
      s.style.backgroundPosition = `${l / (1 - (r - l)) * 100}% 0`;
      s.style.setProperty('--d', kind === 'letter' ? `${120 + i * 85}ms` : '980ms');
      logo.appendChild(s);
    });
    document.body.appendChild(root);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      root.classList.add('out');
      setTimeout(() => { root.remove(); resolve(); }, 650);
    };
    // wait for the image so letters never pop in empty
    const img = new Image();
    img.onload = img.onerror = () => {
      setTimeout(() => root.classList.add('go'), 40);
      setTimeout(finish, 3400);
    };
    img.src = LOGO;
    root.addEventListener('pointerdown', finish);
    addEventListener('keydown', finish, { once: true });
  });
}
