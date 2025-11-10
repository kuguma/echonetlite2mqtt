# echonet-lite.js パッチ適用手順

このドキュメントは、issue #4 の対応のために作成された echonet-lite.js のパッチ適用手順を説明します。

## 概要

issue #4 で報告された2つの問題を修正するため、以下の変更を echonet-lite.js リポジトリに適用する必要があります：

1. **EHD1/EHD2 バリデーション**: 無効な ECHONET Lite パケットをパース前に検証し、拒否する
2. **マルチNICサポート**: IPv4 の addMembership に第2引数を追加して、複数NIC環境で受信インターフェースを指定可能にする

## パッチファイル

パッチファイル: `0001-Fix-EHD-validation-and-multi-NIC-support.patch`

## 適用手順

### 1. echonet-lite.js リポジトリに移動

```bash
cd /path/to/echonet-lite.js
```

### 2. パッチファイルをコピー

このリポジトリのパッチファイルを echonet-lite.js リポジトリにコピーします。

```bash
cp /path/to/echonetlite2mqtt/0001-Fix-EHD-validation-and-multi-NIC-support.patch .
```

### 3. パッチを適用

```bash
git am 0001-Fix-EHD-validation-and-multi-NIC-support.patch
```

または、apply を使用する場合：

```bash
git apply 0001-Fix-EHD-validation-and-multi-NIC-support.patch
git add .
git commit -m "Fix EHD validation and multi-NIC support"
```

### 4. リモートリポジトリにプッシュ

```bash
git push origin master
```

## 変更内容の詳細

### 1. EHD1/EHD2 バリデーション (index.js 462行目付近)

**変更前**:
```javascript
EL.parseString = function (str) {
	let eldata = {};
	if( str.substr(0, 4) == '1082' ) {  // 任意電文形式
		// ...
	}
	// パース処理...
}
```

**変更後**:
```javascript
EL.parseString = function (str) {
	let eldata = {};

	// EHD1/EHD2のバリデーション（パース前にチェック）
	const ehd = str.substr(0, 4);
	if( ehd != '1081' && ehd != '1082' ) {
		console.error("## EL.parseString error. Invalid EHD (expected 1081 or 1082): " + ehd);
		return null;
	}

	if( ehd == '1082' ) {  // 任意電文形式
		// ...
	}
	// パース処理...
}
```

この変更により、EHD1=0x10, EHD2=0x81 または 0x82 以外のパケットは、パース処理の前に拒否されます。

### 2. マルチNIC対応 (index.js 180行目)

**変更前**:
```javascript
EL.sock4.addMembership(EL.EL_Multi);
```

**変更後**:
```javascript
EL.sock4.addMembership(EL.EL_Multi, EL.usingIF.v4);  // マルチNIC対応：第2引数で受信NICを指定
```

この変更により、IPv4 でも IPv6 と同様に、複数NIC環境で特定のインターフェースを指定してマルチキャストを受信できるようになります。

## 次のステップ

パッチを適用して echonet-lite.js リポジトリにプッシュした後、echonetlite2mqtt の package.json は既に更新されているため、`npm install` を実行して新しいバージョンを取得してください。

```bash
cd /path/to/echonetlite2mqtt
npm install
```

## トラブルシューティング

### パッチ適用が失敗する場合

パッチが適用できない場合（コンフリクトなど）、以下の手動変更を適用してください：

1. `index.js` の `EL.parseString` 関数（462行目付近）に、EHDバリデーションを追加
2. `index.js` の `EL.sock4.addMembership` 呼び出し（180行目）に、第2引数 `EL.usingIF.v4` を追加

## 参考情報

- ECHONET Lite 規格書 Version 1.01
- issue #4: https://github.com/kuguma/echonetlite2mqtt/issues/4
