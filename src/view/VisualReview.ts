import type { MatchSnapshot, SpinView } from '../../shared/protocol';
import type { ReelScene } from './ReelScene';
import { cloneMatchStats, createMatchStats, recordSpin } from '../domain/matchStats';
import { evaluateGrid, gridFromStops } from '../domain/game';

export type ReviewExample = 'final-seconds' | 'extension-offered' | 'extension-accepted' | 'extension-rejected' | 'loan-rival-to-player' | 'loan-player-to-rival' | 'text-borrow' | 'text-lend' | 'text-extend' | 'distraction-started' | 'distraction-recovered' | 'session-best' | 'mic-live' | 'mic-reply' | 'mic-muted' | 'mic-quiet' | 'normal' | 'small' | 'diagonal' | 'bell-cherry' | 'cherry-bell' | 'jackpot' | 'rival-jackpot' | 'both-jackpot' | 'quiet' | 'draw' | 'defeat' | 'final' | 'live-caption' | 'live-result-error' | 'live-result-closed' | 'rematch-ready';
interface ReviewPort {
  scene: ReelScene;
  preview: (example: ReviewExample) => void;
  reset: () => void;
  spin: (player: SpinView, rival: SpinView) => void;
  snapshot: (snapshot: MatchSnapshot) => void;
}

/** Loaded only by Vite DEV. Fixtures and capture tools are absent from production. */
export function mountVisualReview(port: ReviewPort): void {
  const controls = document.createElement('aside');
  controls.id = 'visualReview';
  controls.style.cssText = 'position:fixed;z-index:80;left:8px;bottom:8px;max-width:96vw;padding:8px;background:#080b14ed;border:1px solid #cba768;color:white;font:12px system-ui';
  controls.innerHTML = `<details><summary>ローカル検収ツール（本番には含まれません）</summary><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
    <button data-example="normal">通常</button><button data-example="final-seconds">残り8秒</button><button data-example="extension-offered">延長を提案</button><button data-example="extension-accepted">延長受諾</button><button data-example="extension-rejected">延長拒否</button><button data-example="loan-rival-to-player">貸借 RIVAL → YOU</button><button data-example="loan-player-to-rival">貸借 YOU → RIVAL</button><button data-example="text-borrow">TEXT: BORROW（fixture）</button><button data-example="text-lend">TEXT: LEND（fixture）</button><button data-example="text-extend">TEXT: EXTEND（fixture）</button><button data-example="distraction-started">注意逸らし・停止</button><button data-example="distraction-recovered">注意逸らし・復帰</button><button data-example="session-best">自己ベスト・3連勝</button><button data-example="small">小当たり</button><button data-example="diagonal">斜め7</button><button data-example="bell-cherry">ベル／チェリー</button><button data-example="cherry-bell">チェリー／ベル</button><button data-example="jackpot">7揃い・逆転</button><button data-example="rival-jackpot">相手が7揃い</button><button data-example="both-jackpot">両者7揃い</button><button data-example="quiet">両者はずれ</button><button data-example="draw">引き分け</button><button data-example="final">最終スピン</button>
    <button data-example="defeat">敗北</button><button data-example="live-caption">Live字幕の保持</button><button data-example="live-result-error">結果音声の接続失敗</button><button data-example="live-result-closed">結果音声の正常終了</button><button data-example="rematch-ready">Live再戦の準備</button>
    <button data-example="mic-live">聞き取り中</button><button data-example="mic-reply">ライバルの返事</button><button data-example="mic-quiet">マイク待機</button><button data-example="mic-muted">マイクミュート</button>
    <button id="recordMotion">8秒の回転を録画</button><button id="measureMotion">録画なしでFPS計測</button><button id="idleStats">待機5秒を計測</button><button id="cleanFrame">ツールを隠す</button>
    </div><output id="reviewStats" style="display:block;margin:8px 0"></output><details><summary>録画データ</summary><textarea id="recordingData" readonly aria-label="生成した回転動画のデータ"></textarea><video id="reviewVideo" src="/docs/evidence/visual-redesign/downward-reels-1920.webm" preload="metadata" controls muted style="display:block;max-width:400px"></video><button id="slowMotion">1/4速度で再生</button><label>動画時刻（秒）<input id="videoSeek" type="number" min="0" step="0.033" value="0"></label><button id="exportFrame">現在の動画フレームを書き出す</button><textarea id="frameData" readonly aria-label="動画フレームの画像データ"></textarea></details></details>`;
  document.body.append(controls);
  const find = <T extends HTMLElement>(id: string) => controls.querySelector<T>('#' + id)!;
  const stats = find<HTMLOutputElement>('reviewStats');
  controls.querySelectorAll<HTMLButtonElement>('[data-example]').forEach(button => { button.onclick = () => port.preview(button.dataset.example as ReviewExample); });
  find('cleanFrame').onclick = () => { controls.hidden = true; };
  addEventListener('keydown', event => { if (event.key === 'Escape') controls.hidden = !controls.hidden; });
  find('idleStats').onclick = () => {
    port.preview('normal');
    window.setTimeout(() => {
      const before = port.scene.stats();
      window.setTimeout(() => { stats.textContent = JSON.stringify({ idleFrames: port.scene.stats().frames - before.frames, ...port.scene.stats() }); }, 5000);
    }, 300);
  };
  const video = find<HTMLVideoElement>('reviewVideo');
  find('slowMotion').onclick = () => { video.currentTime = 0; video.playbackRate = .25; void video.play(); };
  const seek = document.createElement('button');
  seek.textContent = '指定時刻へ移動';
  find('videoSeek').closest('label')!.after(seek);
  seek.onclick = () => { video.pause(); video.currentTime = Number(find<HTMLInputElement>('videoSeek').value); };
  const position = document.createElement('output');
  position.id = 'videoPosition';
  seek.after(position);
  video.addEventListener('seeked', () => { position.textContent = video.currentTime.toFixed(3) + '秒'; });

  find('exportFrame').onclick = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    find<HTMLTextAreaElement>('frameData').value = canvas.toDataURL('image/png');
  };

  const run = async (record: boolean) => {
    const button = find<HTMLButtonElement>('recordMotion');
    button.disabled = true;
    port.reset();
    const canvas = document.querySelector<HTMLCanvasElement>('#stageArt canvas')!;
    const stream = record ? canvas.captureStream(60) : null;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(type => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';
    const recorder = stream ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3000000 }) : null;
    const chunks: Blob[] = [];
    if (recorder) recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const recording = recorder ? new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType })); }) : Promise.resolve(new Blob());
    recorder?.start();
    let active = true;
    let previous = performance.now();
    const timings: number[] = [];
    let peakCalls = 0, peakTriangles = 0;
    const measure = (now: number) => {
      if (!active) return;
      const state = document.querySelector<HTMLElement>('#stageArt')?.dataset;
      if (state?.spinning === 'true' || state?.win === 'true' || state?.rivalWin === 'true') timings.push(now - previous);
      previous = now;
      const current = port.scene.stats();
      peakCalls = Math.max(peakCalls, current.calls);
      peakTriangles = Math.max(peakTriangles, current.triangles);
      requestAnimationFrame(measure);
    };
    requestAnimationFrame(measure);
    const examples: Array<{ stops: [number, number, number]; bet: 1 | 3 | 5 }> = [
      // Current reel strip: [1] bell, [0] cherry, [8] seven. One active line
      // isolates the advertised miss → bell → cherry → jackpot sequence.
      { stops: [1, 2, 4], bet: 1 }, { stops: [1, 1, 1], bet: 1 }, { stops: [0, 0, 0], bet: 1 }, { stops: [8, 8, 8], bet: 1 },
    ];
    let total = 100, rivalTotal = 100;
    const matchStats = createMatchStats();
    for (let i = 0; i < examples.length; i += 1) {
      const round = i + 1;
      const playerGrid = gridFromStops(examples[i].stops);
      const playerOutcome = evaluateGrid(playerGrid, examples[i].bet);
      total += playerOutcome.payout - examples[i].bet;
      const player: SpinView = { side: 'player', round, symbols: playerGrid[1], grid: playerGrid, stops: examples[i].stops, bet: examples[i].bet, winningLines: playerOutcome.winningLines, payout: playerOutcome.payout, total };
      const rivalStops: [number, number, number] = i === 1 ? [1, 1, 1] : i === 2 ? [0, 0, 0] : [1, 2, 4];
      const rivalBet = 1;
      const rivalGrid = gridFromStops(rivalStops);
      const rivalOutcome = evaluateGrid(rivalGrid, rivalBet);
      rivalTotal += rivalOutcome.payout - rivalBet;
      const rival: SpinView = { side: 'rival', round, symbols: rivalGrid[1], grid: rivalGrid, stops: rivalStops, bet: rivalBet, winningLines: rivalOutcome.winningLines, payout: rivalOutcome.payout, total: rivalTotal };
      recordSpin(matchStats, player);
      recordSpin(matchStats, rival);
      port.snapshot({ matchId: 'visual-fixture', status: 'playing', elapsed: round * 2, remaining: 60 - round * 2, round, rounds: { player: round, rival: round }, balances: { player: total, rival: rivalTotal }, bets: { player: examples[i].bet, rival: rivalBet }, scores: { player: total, rival: rivalTotal }, stats: cloneMatchStats(matchStats), upgrades: { player: [], rival: [] }, eventSeq: i + 1 });
      port.spin(player, rival);
      await new Promise(resolve => window.setTimeout(resolve, i === 3 ? 2400 : 2000));
    }
    active = false;
    recorder?.stop();
    const blob = await recording;
    stream?.getTracks().forEach(track => track.stop());
    if (record) {
    const reader = new FileReader();
    reader.onload = () => { find<HTMLTextAreaElement>('recordingData').value = String(reader.result); };
    reader.readAsDataURL(blob);
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(blob);
    }
    timings.sort((a, b) => a - b);
    stats.textContent = JSON.stringify({ recording: record, scope: 'spin-and-win', samples: timings.length, p95FrameMs: timings[Math.floor(timings.length * .95)], medianFrameMs: timings[Math.floor(timings.length * .5)], peakCalls, peakTriangles, bytes: blob.size, ...port.scene.stats() });
    button.disabled = false;
  };
  find('recordMotion').onclick = () => { void run(true); };

  find('measureMotion').onclick = () => { void run(false); };
  port.preview('normal');
  const parameters = new URLSearchParams(location.search);
  const example = parameters.get('example');
  // Reproducible material comparisons use the same existing review fixtures.
  const exampleButton = [...controls.querySelectorAll<HTMLButtonElement>('[data-example]')]
    .find(button => button.dataset.example === example);
  if (exampleButton) exampleButton.click();
  if (parameters.has('clean-frame')) controls.hidden = true;
}
