import { PAYOUT } from '../domain/game';

/** PC stage markup. Game rules and state transitions live outside this view. */
export function mountGameTemplate(app: HTMLElement): void {
app.innerHTML = `
<section class="shell" inert>
  <div id="stageArt" aria-hidden="true"></div>
  <div class="countdown" id="countdown" tabindex="-1" role="group" aria-label="対戦開始のカウントダウン" aria-describedby="countdownHelp" hidden>
    <div class="countdown-card">
      <span class="countdown-caption">60 SECOND DUEL</span>
      <strong id="countdownValue">3</strong>
      <p id="countdownHelp"><kbd>SPACE</kbd> / クリックで回す<small>両者のリールが、押すたび回転。</small></p>
    </div>
  </div>
  <header class="topbar">
    <h1 id="brand">Slot-chan <small>60 SECOND DUEL</small></h1>
    <div class="timer" id="timer"><small>残り</small><b id="time">60</b><span>秒</span></div>
    <div class="status-cluster" id="status"><span id="modeBadge">未接続</span><button id="sound" aria-label="AI音声をミュート" aria-pressed="false" hidden>AI音声 ON</button><button id="effects" aria-label="効果音をミュート" aria-pressed="false">効果音 ON</button><button id="leave">退出</button></div>
  </header>
  <div class="scores">
    <div class="you" id="playerScore"><span>♛ あなた</span><strong id="ps">0</strong><span class="score-meter" aria-hidden="true"><i id="playerMeter"></i></span></div>
    <div class="rival" id="rivalScore"><span>♜ ライバル</span><strong id="rs">0</strong><span class="score-meter" aria-hidden="true"><i id="rivalMeter"></i></span></div>
    <span class="duel-gap" id="scoreGap" role="status">互角の勝負</span>
  </div>
  <section class="machine" aria-label="あなたのスロット">
    <div id="machineTitle">SLOT-CHAN</div>
    <div class="event-cue" id="eventCue" role="status" hidden></div>
    <div class="pay" id="pay" aria-live="polite"></div>
    <div class="sr-only" id="lastSpin">チェリー・ベル・7</div>
    <div id="machineTrim">中央の1ラインで判定 · 60秒の獲得コインで勝負</div>
  </section>
  <aside class="avatar">
    <span class="sr-only" id="mockFace">CPUライバル</span>
    <video id="avatar" autoplay playsinline></video>
    <span id="rivalMood">正々堂々、60秒。</span>
    <p id="line">「60秒。私に勝てる？」</p>
    <small id="heard"></small>
    <div id="miniLabel">ライバルのリール <strong id="rivalPay" hidden></strong><span>CPU</span></div>
    <strong class="sr-only" id="rivalReels">チェリー・ベル・7</strong>
    <div class="builds" id="builds" aria-label="改造後のリール構成">
      <div id="playerBuildRow"><div class="build-heading"><span>あなたのリール</span><strong id="playerBuild">基本リール</strong></div><div class="build-strip" id="playerStrip" role="img"></div></div>
      <div id="rivalBuildRow"><div class="build-heading"><span>相手のリール</span><strong id="rivalBuild">基本リール</strong><strong id="rivalUpgradeNote" role="status" hidden></strong></div><div class="build-strip" id="rivalStrip" role="img"></div></div>
    </div>
    <div class="connection" id="connection">接続していません</div>
  </aside>
  <div class="upgrade" id="upgrade" hidden>
    <div class="upgrade-heading"><span id="upgradeNo"></span><b id="upgradeTitle">リール改造</b><strong id="upgradeRemain"></strong><span class="upgrade-clock" aria-hidden="true"><i id="upgradeClockFill"></i></span><small id="upgradeChoice" aria-live="polite" tabindex="-1"></small></div>
    <button data-up="steady" aria-pressed="false"><kbd>1</kbd><span class="symbol-icon cherry" aria-hidden="true"></span><strong>安定型</strong><small class="upgrade-pitch">小さく、何度も。</small><span class="upgrade-odds" id="steadyOdds"></span><small class="upgrade-target">チェリー3つで120点</small><small class="upgrade-selected">✓ この作戦でいく</small></button>
    <button data-up="jackpot" aria-pressed="false"><kbd>2</kbd><span class="symbol-icon seven" aria-hidden="true"></span><strong>大勝負</strong><small class="upgrade-pitch">一撃、1,200点。</small><span class="upgrade-odds" id="jackpotOdds"></span><small class="upgrade-target">7が3つで1,200点</small><small class="upgrade-selected">✓ この作戦でいく</small></button>
  </div>
  <footer>
    <section class="result" id="result" aria-labelledby="resultTitle" hidden>
      <small id="resultRounds">60 SECONDS</small>
      <div class="result-heading" role="status" aria-atomic="true"><div><span id="resultEnglish" aria-hidden="true"></span><h2 id="resultTitle"></h2></div><span class="result-emblem" aria-hidden="true"></span></div>
      <div class="result-score" id="resultScore"><div><small>あなたのコイン</small><strong id="resultPlayer"></strong></div><span>VS</span><div><small>ライバルのコイン</small><strong id="resultRival"></strong></div></div>
      <p id="resultGap"></p>
      <details id="resultDetails"><summary>コインと改造の内訳 <span aria-hidden="true">＋</span></summary><table aria-label="対戦の配当と改造の内訳"><thead><tr><th scope="col">獲得コインの内訳</th><th scope="col">あなた</th><th scope="col">ライバル</th></tr></thead><tbody id="resultStats"></tbody></table></details>
      <p class="result-again" id="resultAgain">改造を変えて、もう一度。</p>
    </section>
    <button id="start" disabled>勝負する</button>
    <span id="spinHint" aria-live="polite">クリック / SPACE で回す</span>
    <div id="paytable" aria-label="3つそろうとチェリー120、ベル240、7は1200点"><span><i class="symbol-icon cherry"></i>${PAYOUT.cherry}</span><span><i class="symbol-icon bell"></i>${PAYOUT.bell}</span><span><i class="symbol-icon seven"></i>1,200</span></div>
    <div id="upgradeProgress">⚙ リール改造<small>20秒・40秒で選択</small></div>
  </footer>
</section>
<div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <div class="eyebrow">SLOT-CHAN · 60 SECOND DUEL</div>
    <h2 id="gateTitle">回して、改造して。<br><em>ライバルを超えろ。</em></h2>
    <p>押すたび、両者のリールが回る。<br>60秒のあいだに回して、改造して、<br>ライバルより多くのコインを手に入れよう。</p>
    <p class="gate-strategy">安定型で小当たりを増やすか、<br>大勝負で1,200点を狙うか。<br>改造の5秒前から、効果を見比べられます。</p>
    <div class="gate-payout"><span class="symbol-icon cherry"></span><span class="symbol-icon bell"></span><span class="symbol-icon seven"></span><span>クリック / SPACE で回す。<br>回転中も次の1回を予約。</span></div>
    <button id="practice" class="primary">CPUライバルと対戦 <span>→</span></button>
    <small>PC用・無料・マイク不要。横画面1280×720以上で遊べます。</small>
    <details class="voice-options"><summary>音声・映像もつける（任意）</summary>
      <p>マイク音声を外部AIサービスへ送信します。招待コードが必要です。終了後に接続を閉じ、会話本文は保存しません。</p>
      <label>招待コード<input id="invite" type="password" autocomplete="off" placeholder="Invite code"></label>
      <button id="liveConnect">音声・映像つきで対戦</button>
    </details>
    <small id="gateMessage" role="status">通常のCPU対戦では外部AIサービスに接続しません。</small>
  </div>
</div>
`;

}
