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
      <p id="countdownHelp"><kbd>SPACE</kbd> / クリックで回す<small>ライバルは2秒ごとに自動回転。</small></p>
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
    <div id="miniLabel">ライバルのリール <strong id="rivalPay" hidden></strong><span><b id="rivalRoundCount">00</b> 回転</span></div>
    <strong class="sr-only" id="rivalReels">チェリー・ベル・7</strong>
    <div id="duelRules">
      <strong>ライバルは2秒ごとに自動回転</strong>
      <span>あなたはクリック / SPACE。60秒の獲得コインで勝負。</span>
    </div>
    <div class="connection" id="connection">接続していません</div>
  </aside>
  <footer>
    <section class="result" id="result" aria-labelledby="resultTitle" hidden>
      <small id="resultRounds">60 SECONDS</small>
      <div class="result-heading" role="status" aria-atomic="true"><div><span id="resultEnglish" aria-hidden="true"></span><h2 id="resultTitle"></h2></div><span class="result-emblem" aria-hidden="true"></span></div>
      <div class="result-score" id="resultScore"><div><small>あなたのコイン</small><strong id="resultPlayer"></strong></div><span>VS</span><div><small>ライバルのコイン</small><strong id="resultRival"></strong></div></div>
      <p id="resultGap"></p>
      <details id="resultDetails"><summary>コインの内訳 <span aria-hidden="true">＋</span></summary><table aria-label="対戦の獲得コイン内訳"><thead><tr><th scope="col">獲得コインの内訳</th><th scope="col">あなた</th><th scope="col">ライバル</th></tr></thead><tbody id="resultStats"></tbody></table></details>
      <p class="result-again" id="resultAgain">もう一度、60秒の勝負。</p>
    </section>
    <button id="start" disabled>勝負する</button>
    <span id="spinHint" aria-live="polite">クリック / SPACE で回す</span>
    <div id="paytable" aria-label="3つそろうとチェリー120、ベル240、7は1200点"><span><i class="symbol-icon cherry"></i>${PAYOUT.cherry}</span><span><i class="symbol-icon bell"></i>${PAYOUT.bell}</span><span><i class="symbol-icon seven"></i>1,200</span></div>
    <div id="roundStatus"><span>あなた</span><strong id="roundCount">00</strong><small>SPINS</small></div>
  </footer>
</section>
<div class="gate" id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="gate-card">
    <div class="eyebrow">SLOT-CHAN · 60 SECOND DUEL</div>
    <h2 id="gateTitle">回して、そろえて。<br><em>ライバルを超えろ。</em></h2>
    <p>あなたは連打。ライバルは自動回転。<br>60秒間にライバルより多くの<br>コインを手に入れよう。</p>
    <p class="gate-strategy">中央の横一列が3つそろうと当たり。<br>7がそろえば1,200コイン。<br>最後まで逆転のチャンス。</p>
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
