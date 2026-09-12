# 手動回転の60秒対戦

Issue #64。クリックまたはSpaceで両者が1回転する操作へ変更した。回転中の追加入力は次の1回を予約し、連打で予約が蓄積しない。ボタンは「回す」「次も回す」「予約済み」を表示する。

改造パネルを右側へ移し、選択中も主リール・相手の小リール・回すボタンを見える状態にした。絵柄の表示枚数は確定した構成と連動する。

CPU・Liveとも最短1.1秒間隔で、両者が同じ回数だけ抽選される。60秒以降は受け付けず、終了前に受け付けた最終リールが停止してから結果を表示する。無操作では回らず、最大55回。結果には実回転数を表示する。Liveではサーバーが時刻・commandIdを検証する。

## 確認

- ローカルChromeの通常CPU対戦で、開始後の無操作は0回、Spaceと連打は予約1回を含め2回で停止することを確認。
- 改造受付中に選択・クリック・次回予約を実行。60秒終了時には実際の4回転、120対120の引き分けを表示。
- 再戦は時間・得点・構成・回転数・予約を初期化し、フォーカスを回すボタンへ戻す。Spaceで1回転できた。
- 型検査・lint・203件の既存/境界テスト成功。実localhost WebSocketの結合確認でも手動spin要求を送信し、実際のサーバー処理と応答を使用した。外部音声プロバイダーと認証は代替で、実APIの音声検証とは区別する。

[改造中の操作画面](evidence/manual-spin/upgrade-1280.webp) · [実回転数の結果画面](evidence/manual-spin/result-1280.webp) · [操作記録](evidence/manual-spin/local-flow.json)

## 公開確認

PR #66のコード `65a21e34d6978bd23d6f2f1eef47b28fd5159fb0` を https://slot-chan.vercel.app に公開。Vercel `dpl_GmPiL3PNCQTp2BtuodXgbnvXTdYh` READY、[マージ後CI成功](https://github.com/yuin15/donburi-g/actions/runs/34678942012)。#63/#64をクローズした。

公開Chromeで実際に連打し、32回転・840対1,080の敗北まで確認した。1回目はキー1で安定型、2回目は無入力の既定安定型。残り0秒で最終停止中となり、31回転の表示から32回転目の確定得点へ更新した後に結果が出る。締切で予約は取り消され、余分な33回転目は生じなかった。

再戦は得点・回転数・構成・予約を初期化し、Spaceと追加クリックで2回転して停止した。1920×1080で両者が回転する状態を目視。外部/API通信0、JavaScriptエラー0。公開の無効Live入口もHTTP 401 / WebSocket1008で拒否される。

[公開プレイ画面](evidence/manual-spin/public-play-1920.webp) · [公開32回転の結果](evidence/manual-spin/public-result-1280.webp) · [公開操作記録](evidence/manual-spin/public-flow.json)

公開JS `index-DPJmBELS.js`、CSS `index-nEaOVh7L.css` が検証版と一致する。主JS137.41KB gzip、CSS5.37KB gzip。
