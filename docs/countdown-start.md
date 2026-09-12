# カウントダウン中のSpaceで誤退出しない

Issue #75。公開版でCPU対戦を開始し、「3」の間にSpaceを押すと退出して入口へ戻る問題を再現した。開始時にViewが退出ボタンへフォーカスを移していたため、回転の先行入力がボタンの標準操作になっていた。

カウントダウン自体をフォーカス先にし、その間のSpaceでページをスクロールさせない。開始後は従来どおり「回す」へ移す。カウントダウンには操作キーと金色の枠を添えた。変更はMVVMのView・HTML・CSSに限定し、対戦時間・抽選・予約・通信は変更していない。

ローカルChromeで次を確認した。[操作記録](evidence/countdown/local.json)。

- 開始前にSpaceを4回押しても入口へ戻らず、両得点0・初期絵柄を保持。
- 開始後のSpaceで両者が1回転し、停止後に両者の出目を更新。
- カウントダウン中の退出クリック、およびTabで効果音→退出を選んでEnterを押す取消が機能する。
- 1280×720 / 1920×1080の表示を目視確認。

![1280×720の開始表示](evidence/countdown/countdown-1280.webp)

[1920×1080の開始表示](evidence/countdown/countdown-1920.webp)。型検査・lint・既存210テスト・生成済みサーバー起動・本番ビルドが成功。500KB超の既存ビルド警告は残る。

PR #76を公開。コード `0f197b1860b4295394df0163b49ea2a94170b944`、Vercel `dpl_BwRgH7EhkLvb2LuUynJzzN1jBbZV` はREADY、[マージ後CI](https://github.com/yuin15/donburi-g/actions/runs/34685548391)はsuccess。

公開Chromeでも先行Space4回→初期得点・絵柄を保持→開始後のSpaceで両者1回転、Tab/Enter取消・クリック取消を確認。Resource Timingで外部/API要求なし、任意Liveクライアントの読み込みなし。[公開操作記録](evidence/countdown/public.json)、[公開画面](evidence/countdown/public-countdown-1280.webp)。主JSは`index-CS9XBjIE.js`、CSSは`index-aE-Q_cR0.css`。
