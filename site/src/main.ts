import './style.css';

// The hero note types itself: a sentence, a pause, Onward's gray suggestion, then Tab.
// Only timers run (no animation frames), and everything stops when the note is off screen,
// the tab is hidden, or the visitor prefers reduced motion.

type Beat = { typed: string; ghost: string };
type Step = [action: () => void, delayMs: number];

const beats: Beat[] = [
  {
    typed: 'Somewhere around the second corner my head goes quiet,',
    ghost: ' and whatever I was stuck on starts to sort itself out.',
  },
  {
    typed: ' I used to think I had to be thinking about the problem to solve it.',
    ghost: ' Now I think I mostly have to stop standing in its way.',
  },
];

const note = document.getElementById('note')!;
const line = document.getElementById('line')!;
const hint = document.getElementById('hint')!;
const status = document.getElementById('status')!;

let accepted = '';
let typed = '';
let ghost = '';
let caretOn = true;
let timer = 0;
let blink = 0;
let running = false;
let queue: Step[] = [];

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function render() {
  line.innerHTML =
    escapeHtml(accepted + typed) +
    `<span class="caret${caretOn ? '' : ' off'}"></span>` +
    (ghost ? `<span class="ghost">${escapeHtml(ghost)}</span>` : '');
}

function setStatus(s: string) {
  status.textContent = s;
}

// One loop of the demo as small steps, each followed by a delay.
function buildScript(): Step[] {
  const steps: Step[] = [];
  for (const beat of beats) {
    steps.push([() => setStatus('waiting'), 400]);
    for (let n = 1; n <= beat.typed.length; n++) {
      steps.push([() => (typed = beat.typed.slice(0, n)), 38 + Math.random() * 45]);
    }
    steps.push([() => setStatus('generating'), 1300]);
    steps.push([
      () => {
        ghost = beat.ghost;
        setStatus('generated · shown');
        hint.classList.add('on');
      },
      2100,
    ]);
    steps.push([
      () => {
        accepted += typed + ghost;
        typed = '';
        ghost = '';
        hint.classList.remove('on');
        setStatus('waiting');
      },
      900,
    ]);
  }
  steps.push([() => {}, 2600]);
  steps.push([() => (accepted = ''), 700]);
  return steps;
}

function tick() {
  if (!running) return;
  if (!queue.length) queue = buildScript();
  const [action, delay] = queue.shift()!;
  action();
  caretOn = true;
  render();
  timer = window.setTimeout(tick, delay);
}

function start() {
  if (running) return;
  running = true;
  blink = window.setInterval(() => {
    caretOn = !caretOn;
    render();
  }, 530);
  tick();
}

function stop() {
  running = false;
  window.clearTimeout(timer);
  window.clearInterval(blink);
  caretOn = true;
  render();
}

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  accepted = beats[0].typed;
  ghost = beats[0].ghost;
  hint.classList.add('on');
  setStatus('generated · shown');
  render();
} else {
  render();
  let visible = false;
  const update = () => (visible && !document.hidden ? start() : stop());
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    update();
  }).observe(note);
  document.addEventListener('visibilitychange', update);
}
