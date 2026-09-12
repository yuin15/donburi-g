# ビジュアル再制作の検証

2026-09-12 / PR #41 / #5、#36〜#40。以下は新しいThree.jsステージの実装と実Chromeの観測結果。旧版のCIや配置確認を、参考画像に沿った見た目の評価に流用していない。ユーザーの美的な承認そのものを代行する記録ではない。

## 参考と実装の比較

| 観点 | 参考から採用した要素と修正 |
| --- | --- |
| 構図 | 左に大きな3リールと張り出した操作台、右に人物・吹き出し・小リール、上に時間と双方得点。大きな外側の余白を廃止 |
| 材質 | 彫刻・縁・反射・黒い塗装・暖色照明を専用の背景画像に焼き込み、湾曲リールと手前の光・金貨を重ねる。単なる金色の矩形から変更 |
| 絵柄 | システム絵文字を専用のチェリー・ベル・赤7へ変更。相手の横長窓では正方形セルの比率を保ち、左右を象牙色の余白にする。ユーザー指摘の縦潰れを修正 |
| 人物 | 本プロジェクト用に生成した架空の成人ライバルの4表情。CPUのみで表情・台詞・作戦表示が成立。参考の人物画像は配布しない |
| 回転 | 同じ絵柄が上から入り、中央を通過し、下へ抜ける連続UV移動。加速・等速・減速を経て820/940/1060msで左・中・右を順に停止 |
| 当たり | 小当たりは中央ラインと+配当、7揃いは最大24枚の金貨、逆転は首位交代を確認した時だけ表示。顔とHUDを避けて配置 |
| 操作 | 赤い開始・自動回転状態・再戦を操作台に統合。20/40秒の2択改造、数字キー、ミュート、退出を維持。狭い画面では同じ素材を縦に配置 |

参考の名称・3分ルールは採用せず、Slot-chan、60秒、30回転、配当120/240/1200、無料改造2回を維持。ゲームの抽選・得点は共通ドメインが確定し、表示側は出目を操作しない。

## 静止画と実回転動画

静止画の通常・小当たり・逆転・同点・最終スピンはDEV専用の検収画面から、実際の描画とUIを使って再現したもの。自然抽選のCPU対戦結果とは区別する。検収ツール・固定出目は本番バンドルに含まれないことを検索で確認した。

| 状態 | 1280×720 | 1920×1080 |
| --- | --- | --- |
| 通常 | [画面](evidence/visual-redesign/normal-1280.webp) | [画面](evidence/visual-redesign/normal-1920.webp) |
| 小当たり | [画面](evidence/visual-redesign/small-win-1280.webp) | [画面](evidence/visual-redesign/small-win-1920.webp) |
| 7揃い・逆転 | [画面](evidence/visual-redesign/jackpot-1280.webp) | [画面](evidence/visual-redesign/jackpot-1920.webp) |

- [実際の下向き回転・小当たり・7揃いの動画](evidence/visual-redesign/downward-reels-1920.webm)：約8秒。Three.jsキャンバスの録画で、HTMLの得点・台詞は静止画で補う。ステージの縦横比により映像の実寸は1919×1080。
- 連続フレーム：[0.200秒](evidence/visual-redesign/frame-0200.webp)、[0.233秒](evidence/visual-redesign/frame-0233.webp)、[0.266秒](evidence/visual-redesign/frame-0266.webp)。左リールの同じチェリーが上部→中央→下部へ移動し、上側から次の7が入ることを目視した。
- [最終スピン後の結果](evidence/visual-redesign/final-result-1920.webp)、[引き分け](evidence/visual-redesign/draw-1920.webp)。最終回の回転中は残り0秒でも結果を伏せ、停止後に3,600対3,240と勝利を表示。
- 自然抽選の本番用ビルド：[1試合目](evidence/visual-redesign/cpu-result-1920.webp)は720対840、[再戦](evidence/visual-redesign/cpu-rematch-result-1920.webp)は840対1,200。再戦では大勝負→安定型を数字キー2→1で選択し、両ボタンのロック、選択済みフォーカス、最終履歴との一致を確認した。

検収画面は開発サーバーの `/?visual-review`。通常・小当たり・7揃い・同点・最終回・改造を選べる。録画、1/4速度再生、時刻指定、動画のフレーム書き出し、待機計測ができる。成果物や検証画面にAPIキー・メール・実会話は含まない。

## 描画性能

実Windows Chrome 152、Ryzen 7 8700G、RTX 4070 Ti SUPER、60Hz、1920×1080、DPR 1。Chromeを最前面にし、重いビルド処理を並行しない条件で4スピンと小当たり・金貨演出を計測。全端末で厳密に60fpsを保証する値ではない。

| 測定 | 結果 | 初期予算 |
| --- | --- | --- |
| 回転・当たり中フレーム時間 | 中央値17.6ms、p95 18.1ms、388標本 | p95 20ms以下、60fpsを目標 |
| 描画呼び出し | 通常9、金貨最大時33 | 80以下 |
| 三角形 | 通常204、金貨最大時252 | 60,000以下 |
| テクスチャ | 4点、mipmap込み概算20.4MiB | 48MiB以下 |
| 5秒間の静止 | 追加描画0フレーム | 静止/非表示で連続描画しない |
| 画像 | 4点合計536,648 bytes | 初期転送全体2.5MB以内 |

[録画なし・回転と当たりを含む](evidence/visual-redesign/rendering-metrics.json)、[録画時の回転区間](evidence/visual-redesign/recording-metrics.json)、[静止](evidence/visual-redesign/idle-metrics.json)の測定値を添付。通常CPU入口は本番ビルドの主JS約135KB gzipとCSS約4KB gzipだけを読み、LiveKit SDKを未読込と確認。2試合後のResource Timingにも外部オリジンやAPI要求なし。PR #42ではLiveClient自体も遅延読込へ移し、CPU用主JSは約133KB gzipになった。

## 公開版の通し確認

PR #41のmain `e99e88009c32f6fe0253d5c9d38409eda8d5fb9f`、Vercel `dpl_FSGJF8cRW24uwLu75jb4bTbsKhDS` はREADY。公開URLは https://slot-chan.vercel.app 。マージ後CI https://github.com/yuin15/donburi-g/actions/runs/34670929185 は成功。

- 公開Chromeで40秒の改造を数字キー1で選択。終盤にページを25秒凍結し、復帰後360対840、双方30回転の決着へ追いついた。[対戦画面](evidence/visual-redesign/public-playing-1280.webp)、[結果1280](evidence/visual-redesign/public-result-1280.webp)、[結果1920](evidence/visual-redesign/public-result-1920.webp)、[390×844](evidence/visual-redesign/public-mobile-390.webp)。
- 再戦を押した直後から0対0・未改造・結果非表示へ戻り、Enterでカウントダウンを取消できた。低減モーション設定の認識も確認。
- [公開通信](evidence/visual-redesign/public-network.json)は初期転送約0.684MB、外部オリジン/API要求なし、任意SDK未読込、描画キャンバス1つ、検収ツールなし。JavaScriptエラーログ0件。faviconの404を1件検出し、PR #42で既存の金貨アイコンを指定した。

公開CPU対戦と任意Liveの検証範囲を区別する。Chromeの権限設定画面への移動はブラウザの安全規則で拒否されたため、実マイク拒否の操作確認はスキップした。模擬マイク拒否テストをその代わりの実機結果とは記載しない。

## 自動確認と範囲

型検査、lint、84テスト、生成後Node ESMのAPI起動・LIVE無効時のHTTP/WebSocket拒否、本番ビルドが成功。主JSと任意LiveKitチャンクの500KB超警告は残る。描画テストは下向きの30/60/120Hz、順次停止、遅着/重複/再戦、両者同時加点、最終回、低減モーション、非表示中の描画停止、リソース解放、小リールのPC/モバイル縦横比を含む。

実Edge、初見の方の遊びやすさ・音質評価は #12。実サービスを使う音声・映像、課金上限の実測は #3 / #8 / #9 / #11 に残す。通常CPU対戦の開始条件にはしない。`LIVE_MODE_ENABLED=false` を維持し、実API接続・課金利用は実施していない。
