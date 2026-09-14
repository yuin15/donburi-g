import './style.css';
import './view/DuelPanels.css';
import './view/WinImpact.css';
import './view/ArtDirection.css';
import './view/PhysicalPresentation.css';
import { createLiveSessionFactory } from './client/LiveSession';
import { GameView } from './view/GameView';
import { GameViewModel } from './viewmodel/GameViewModel';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing_app');

const view = new GameView(app);
const model = new GameViewModel({
  clock: {
    now: () => performance.now(),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: id => window.clearTimeout(id),
  },
  random: Math.random,
  isVisible: () => !document.hidden,
  liveFactory: createLiveSessionFactory(view.video),
  presentation: view,
});

let unsubscribe = () => {};
let disposeAiDebug = () => {};
let disposed = false;
if ((import.meta.env.DEV || import.meta.env.MODE === 'review') && new URLSearchParams(location.search).has('visual-review')) {
  void import('./dev/GameReview').then(({ mountGameReview }) => mountGameReview(view, model.state));
} else {
  view.bind(model);
  unsubscribe = model.subscribe(state => view.render(state));
  // This entire module (including its markup and CSS) is eliminated from production builds.
  if (import.meta.env.DEV) void import('./dev/AiDebug').then(({ mountAiDebug }) => {
    if (!disposed) disposeAiDebug = mountAiDebug(model);
  });
}

const dispose = () => {
  if (disposed) return;
  disposed = true;
  disposeAiDebug();
  unsubscribe();
  model.dispose();
  view.dispose();
};
addEventListener('beforeunload', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(() => {
  removeEventListener('beforeunload', dispose);
  dispose();
});
