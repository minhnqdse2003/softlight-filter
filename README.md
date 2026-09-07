# filmong-filter

Hậu kỳ ảnh cho dslrBooth. Chạy trên máy booth, được dslrBooth gọi ở mục
**Post-Processing**, xử lý ghi đè lên chính file ảnh — nên hiệu ứng có mặt trên
cả bản in lẫn bản digital.

## Hai bộ lọc, một bộ xử lý

| Bộ lọc | id | Trỏ dslrBooth tới | Cấu hình | Trang chỉnh |
|---|---|---|---|---|
| **Soft Light** | `softlight` | `softlight.exe` | `softlight.config.json` | `web/softlight-tuner.html` |
| **Instax Wide** | `instax` | `instax.exe` | `instax.config.json` | `web/instax-tuner.html` |

Soft Light làm mềm da bằng bloom trên mặt nạ tông da, phông nền giữ nguyên nét.
Instax Wide dựng chất phim lấy liền: vibrance chọn lọc, matte black, tách tông
lam/kem, hạt phim.

Mở **`web/index.html`** để đi tới trang chỉnh của từng bộ lọc — đó là chỗ tập
trung mọi bộ lọc, kèm hướng dẫn cắm vào dslrBooth.

Hai bộ lọc dùng chung một bộ xử lý (`src/cli.js`): cùng cách bắt lời gọi của
dslrBooth, cùng cách backup, cùng khoá chống chạy chồng, cùng cách ghi file
nguyên tử. Khác nhau đúng ở phần biến đổi ảnh. Mỗi bộ lọc có **file exe, file
cấu hình, file log, file khoá và file tạm riêng** — đặt tên theo `id` — nên chạy
cạnh nhau không đụng gì của nhau.

> **Chạy cả hai trên cùng một thư mục ảnh?** Phải đổi `backup.folder` của bộ lọc
> thứ hai sang tên khác. Sự tồn tại của bản backup chính là dấu hiệu "đã xử lý",
> nên dùng chung một thư mục backup thì bộ lọc chạy sau sẽ bỏ qua sạch.

Phần README từ đây trở xuống mô tả **bộ lọc Soft Light**; mục
[Bộ lọc Instax Wide](#bộ-lọc-instax-wide) ở cuối nói riêng về bộ còn lại. Mọi
lệnh đều nhận thêm cờ `--filter <id>`; không có cờ thì chạy Soft Light.

---

## Hiệu ứng gồm những gì

Tầng chính là **bloom có mặt nạ da** — dựng lại đúng thuật toán của bản tham
chiếu `instagram-soft-light-1.html`:

> Ảnh **gốc** giữ nguyên nét làm nền. Một bản sao được lọc chỉ còn pixel tông
> da (và bỏ luôn pixel quá sáng), làm mờ thật mạnh, tăng sáng rồi `screen` đè
> lên nền. Da phát sáng mềm mại, còn phông nền — chấm bi, hoa văn, chữ trên
> backdrop — vẫn sắc nét nguyên vẹn.

Các tầng còn lại **mặc định tắt** (`amount: 0`), giữ lại để nêm thêm khi cần:

| # | Tầng | Làm gì | Tham số | Mặc định |
|---|---|---|---|---|
| 1 | Soft focus | Pha lớp mờ **bán kính nhỏ** vào toàn ảnh → da mịn, tóc mềm, nhưng phông cũng mềm theo | `softFocus.amount`, `softFocus.radiusPct` | tắt |
| 2 | Clarity | Pha lớp mờ **bán kính lớn** vào toàn ảnh → hạ tương phản dải tần trung | `clarity.amount`, `clarity.radiusPct` | tắt |
| 3 | **Bloom trên vùng da** | **Tầng chính**, mô tả ở trên | `bloom.*` | **bật, 0.7** |
| 4 | Tone | Giảm contrast quanh điểm giữa + nâng vùng đen → bạc màu, ethereal | `tone.contrast`, `tone.lift` | tắt |
| 5 | Ấm | Lệch gain giữa các kênh + phủ soft-light màu ấm lên vùng sáng | `warm.*` | tắt |
| 6 | **Nhiễu hạt** | Hạt phim: nhiễu trắng **kết cụm**, rải theo đường cong sắc độ, tách ba lớp màu | `grain.*` | **bật, 0.014** |

### Vì sao cắt theo màu da chứ không theo độ sáng

Cách cũ cắt lớp mờ theo **ngưỡng độ sáng**: chỉ giữ vùng sáng hơn `threshold`
rồi screen lên ảnh. Nghe hợp lý, nhưng trong booth thì chỗ **sáng nhất** khung
hình lại chính là chấm bi trắng, đèn và mảng cháy sáng của phông — nên phông
loè lên trước cả khuôn mặt.

Bây giờ mặt nạ cắt theo **màu**: `r > 80 && g > 35 && b > 20 && r − g > 10 &&
r > b` bắt được da người châu Á lẫn ánh tóc nâu đỏ, và pixel sáng hơn
`bloom.highlightCutoff` (mặc định 0,863 ≈ 220/255) bị **loại**, tức là ngược
hẳn logic cũ.

`--selftest` đo thẳng điều này: mức thay đổi trên vùng da phải gấp ít nhất 3
lần mức thay đổi trên phông.

### Hạt phim, không phải nhiễu cảm biến

Rải nhiễu trắng đều khắp khung là cách nhanh nhất để ảnh trông như chụp thiếu
sáng bằng điện thoại. Tầng 6 giải bốn điểm khiến hạt phim khác hẳn nhiễu số:

| Đặc tính | Cách làm | Tham số |
|---|---|---|
| Hạt có **kích thước** — tinh thể muối bạc kết tụ thành cụm rồi còn nhoè thêm qua quang học | nhiễu trắng rồi **làm mờ**, không phải nhiễu từng pixel | `grain.sizePx` |
| Hạt **phụ thuộc sắc độ** — phản ứng hoá học bão hoà ở vùng cháy sáng, chưa xảy ra ở vùng đen kịt | đường cong smoothstep cuộn về 0 ở hai đầu dải, tra bảng 256 mức | `grain.shadowRolloff`, `grain.highlightRolloff` |
| Ba lớp thuốc nhuộm **độc lập, khác cỡ** — lớp lam trên cùng thô nhất, lớp đỏ mịn nhất | ba lớp nhiễu riêng, cỡ R/G/B = 0,8 / 1,0 / 1,4 và cường độ 0,75 / 1,0 / 1,75 | `grain.chroma`, `grain.mono` |
| Cỡ hạt phải **theo độ phân giải** | `sizePx` neo ở ảnh cạnh dài 4000px, nhân theo `cạnh dài / 4000` | — |

Hai điểm dễ vấp:

- **Làm mờ nuốt mất phương sai.** Sau khi làm mờ, độ lệch chuẩn của lớp nhiễu
  tụt mạnh và mức tụt còn phụ thuộc việc ép về 8-bit. Nên phải **đo** rồi chuẩn
  hoá `(giá trị − trung bình) / độ lệch chuẩn`, chứ không suy ra bằng công thức.
  Đo trên mảnh 640×640 là đủ — nhiễu là dừng nên ước lượng sai dưới 0,5%.
- **`chroma = 1` không phải "chuẩn nhất".** Bộ số 0,75 / 1,0 / 1,75 vốn dành cho
  không gian tuyến tính dải rộng; đổ nguyên vào sRGB 8-bit thì phần lệch kênh
  đọc ra thành đốm màu kiểu nhiễu cảm biến. Mặc định `0.5` lấy một nửa độ lệch.

Hạt cộng **sau cùng**, sau mọi tầng khác — quy tắc "khử trước, thêm hạt sau".
Nó cũng đóng vai dither: một lượng hạt rất nhỏ đủ phá vệt đứt dải (banding) trên
nền chuyển sắc mượt của phông booth.

---

## Cài đặt trên máy booth

```bat
:: 1. Cài Node.js 18 trở lên  (https://nodejs.org — bản LTS)
:: 2. Chép cả thư mục này vào máy booth, ví dụ C:\filmong-softlight
:: 3. Mở cmd trong thư mục đó:
npm install
build-exe.bat
node src\cli.js --selftest
```

`--selftest` in ra bốn bảng. Cần thấy: hai dòng có chấm điểm ở bảng đầu đều
**ĐẠT** (những dòng ứng với tầng đang tắt hiện `—`), tỉ lệ da/phông ít nhất
3 lần, và biên độ hạt đậm ở trung gian rồi cuộn về 0 ở hai đầu dải. Bảng hài
hoà cuối cùng đo trên ảnh kiểm tổng hợp nên hai dòng đầu hầu như luôn cảnh báo
— chấm thật bằng `--preview` trên ảnh chụp thật.

`build-exe.bat` tạo ra `softlight.exe` (6KB) bằng trình biên dịch C# đi kèm
Windows — không cần cài thêm gì. Chỉ phải chạy một lần; sửa
`softlight.config.json` về sau **không** cần build lại.

Nếu `node` không nằm trong PATH, tạo file `node-path.txt` cạnh `softlight.exe`,
nội dung là đường dẫn đầy đủ tới `node.exe`.

---

## Cắm vào dslrBooth

**Settings → Effects & Stickers → Post-Processing → On → Application:**

```
C:\filmong-softlight\softlight.exe
```

dslrBooth gọi `softlight.exe "C:\...\IMG_0001.jpg"` sau mỗi lần chụp; chương
trình xử lý rồi **ghi đè lên đúng tên file cũ**, đúng như tài liệu dslrBooth yêu
cầu với một ứng dụng post-processing.

### Vì sao phải là .exe, không dùng .bat

1. Hộp thoại **Choose** của dslrBooth chọn file thực thi.
2. File `.bat` chạy qua `cmd.exe`, mà cmd **phân tích lại dòng lệnh**. Tham số
   chứa ký tự `|` sẽ bị hiểu thành toán tử pipe và làm vỡ lệnh — lỗi xảy ra
   *trước khi* file .bat chạy nên không thể sửa từ bên trong. `softlight.exe`
   nhận argv trực tiếp, không qua shell.
3. Biên dịch ở dạng `winexe` nên **không có cửa sổ console nháy lên** mỗi lần
   khách chụp.

### Dùng qua Triggers thay thế (không bắt buộc)

`softlight.exe` nhận cả hai kiểu gọi và tự phân biệt bằng tham số đầu tiên:

| Cách gọi | Dạng | Xử lý |
|---|---|---|
| Post-Processing | `softlight.exe "…\IMG.jpg"` | Áp hiệu ứng, ghi đè |
| Triggers | `softlight.exe file_download "…\IMG.jpg"` | Áp hiệu ứng, ghi đè |
| Triggers | `softlight.exe processing_start …` | Chỉ ghi dấu thời gian |
| Triggers | sự kiện khác | Không làm gì |

Việc phân biệt dựa trên danh sách tên sự kiện đã biết, không đoán theo hình dạng
chuỗi — nên một file tên `printing.jpg` không bị hiểu nhầm thành sự kiện.

**Chỉ nên cắm MỘT trong hai.** Nếu cắm cả hai thì mỗi ảnh bị gọi hai lần; khoá
chống chạy song song sẽ chặn được mờ chồng mờ, nhưng vẫn tốn công vô ích.

---

## Kiểm chứng hiệu ứng có vào BẢN IN không

Post-Processing được thiết kế đúng cho việc này — tài liệu dslrBooth nói ứng
dụng phải "save to the same filename when it has completed processing", nghĩa là
dslrBooth dùng file sau khi ứng dụng xong. Nhưng vẫn nên kiểm chứng một lần trên
chính máy của bạn:

```bat
del logs\softlight.log
:: chụp thử một phiên đầy đủ, rồi:
notepad logs\softlight.log
```

Mỗi ảnh phải có đúng một dòng `"ev":"done"`. Nếu bạn cũng bật Triggers thì dòng
`"ev":"processing_start"` phải đứng **sau** tất cả các dòng `done` — nếu có dòng
`done` đứng sau nó, ảnh đó đã bị ghép template trước khi xử lý xong.

Cách chắc chắn nhất: chụp một phiên rồi mở ảnh trong `_original\` so với ảnh
cùng tên ở thư mục cha. Nếu khác nhau thì việc ghi đè đã thành công; sau đó chỉ
cần nhìn tờ in.

### Tốc độ

Đo trên máy này (Node 24, libvips 8.17), thời gian **tường** trọn vẹn từ lúc
dslrBooth gọi tới lúc `softlight.exe` thoát:

| Độ phân giải | Xử lý ảnh | Khởi động Node + sharp | **Tổng** |
|---|---|---|---|
| 24MP (6000×4000) | ~1,83s | ~460ms | **~2,3s** |
| 11MP (4000×2667) | ~820ms | ~460ms | **~1,3s** |

Đo trên máy booth của bạn: `node src\cli.js --bench <ảnh thật>`

Tầng hạt chiếm khoảng **460ms** trong số đó trên ảnh 24MP, và làm **file JPEG
phình từ 5,1 MB lên 7,9 MB** — nhiễu vốn rất khó nén. Với một sự kiện 500 ảnh
thì chênh khoảng 1,4 GB, đáng cân nhắc nếu ổ đĩa máy booth chật.

Nếu quá chậm hoặc quá nặng, xử lý theo thứ tự hiệu quả giảm dần:

1. Hạ độ phân giải chụp trong dslrBooth — đòn bẩy mạnh nhất, thời gian tỉ lệ
   thẳng với số điểm ảnh.
2. Đặt `grain.mono: true` — kéo file về ~5,8 MB, hạt vẫn giữ chất phim, chỉ
   mất phần lệch màu giữa ba lớp.
3. Hạ `output.quality` xuống 90.
4. Đặt `grain.amount: 0` nếu vẫn chật — nhưng nhớ rằng lúc đó vệt đứt dải trên
   nền chuyển sắc của phông sẽ hiện lại.
5. Giữ `softFocus.amount` và `clarity.amount` ở 0 (mặc định) — mỗi tầng bật
   thêm là một lượt làm mờ toàn ảnh nữa.

---

## Chỉnh tham số

### Cách nhanh: bảng chỉnh trong trình duyệt

Bấm đúp `web/softlight-tuner.html`. Thả một tấm ảnh vào, kéo slider, nhìn ngay
kết quả trên chính tấm ảnh đó, rồi bấm **Sao chép** để lấy về đúng
`softlight.config.json` đầy đủ — dán đè lên file cũ là xong.

Sidebar gom thành **năm tấm gập được**, chỉ tầng chính mở sẵn; mỗi tấm đang gập
vẫn hiện dòng tóm tắt bên phải (`0.70`, `0.014`, `tắt`…) nên biết ngay mục đó
có tác động gì không mà không phải mở ra. Trạng thái gập/mở được nhớ lại giữa
các lần mở trang.

Dưới khung xem có **bốn thẻ chấm độ hài hoà** (xanh = đạt, đỏ = cảnh báo), đo
thẳng trên ảnh đã lọc và nói luôn phải xoay tham số nào — xem mục dưới.

Toàn bộ chạy trong trình duyệt, ảnh không đi đâu cả. Trang này dựng lại đúng
sáu tầng của `src/pipeline.js`, kể cả cách ghép tay lớp bloom (bỏ nhân alpha
trước khi áp brightness/contrast) và đường cong đáp ứng của tầng hạt; đối chiếu
với `sharp` thật thì sai lệch trung bình **1,0/255 (0,4%)**, lớn nhất 9/255 —
đo đầu-cuối: thả ảnh 24MP vào tuner rồi so khung xem với ảnh do exe xuất ra thu
về cùng kích thước. Phần dư đến từ box blur xấp xỉ Gauss và dồn hết ở đúng
đường viền mặt nạ da. Biên độ hạt lệch dưới 5%, các thước đo hài hoà lệch dưới 1%.

Một khác biệt cố ý: khung xem dựng hạt ở **đúng cỡ pixel của ảnh thật**, nên nó
cho thấy hạt khi soi 100%. In ra hoặc xem thu nhỏ cả khung thì hạt sẽ dịu hơn.

Sửa `web/tuner.html` xong thì chạy `node web/build-offline.mjs` để dựng lại bản
bấm đúp.

### Cách chắc chắn: xem bản do chính exe xuất ra

Sửa thẳng `softlight.config.json`, không cần build lại. Xem trước mà **không**
đụng vào ảnh gốc:

```bat
node src\cli.js --preview "C:\dslrBooth\Photos\IMG_0007.jpg"
```

Ghi ra `IMG_0007.SO-SANH.jpg` — trái là gốc, phải là đã xử lý.

Kiểm chứng bằng số đo thay vì bằng mắt:

```bat
node src\cli.js --selftest
```

In ra bảng chỉ số kèm diễn biến qua từng tầng. Quy tắc đọc quan trọng nhất:
**mức thay đổi trên vùng da phải lớn hơn hẳn mức thay đổi trên phông** — dòng
cuối bảng in thẳng tỉ lệ đó, cần ít nhất 3 lần. Nếu tỉ lệ tụt xuống thì phông
đang bị loè cùng với da: kiểm tra `bloom.skinOnly` và hạ `bloom.highlightCutoff`.

Những chỉ số chỉ có nghĩa khi tầng tương ứng được bật (độ nét, clarity, độ ấm)
sẽ hiện dấu `—` ở cột kết quả thay vì chấm đạt / không đạt.

Bảng thứ hai chấm **đường cong đáp ứng của tầng hạt**: biên độ hạt ở trung gian
phải lớn hơn hẳn ở đen kịt và cháy sáng, ít nhất 2 lần mỗi bên. Rải đều là dấu
hiệu hạt đang đọc ra như nhiễu số.

Với cấu hình mặc định: độ sáng +32%, tương phản tổng thể −27%, mức thay đổi
trên da gấp ~10 lần trên phông.

### Bảng chấm độ hài hoà

Khác với các chỉ số ở trên — vốn chỉ nói ảnh **đổi** thế nào — bảng này chấm ảnh
đầu ra có **dùng được** không, và sai thì xoay tham số nào. Hiện ở cả
`--selftest`, `--preview` và bốn thẻ dưới khung xem của tuner, dùng chung một
bộ ngưỡng nên không bao giờ nói hai điều khác nhau.

| Chỉ số | Đo gì | Đạt khi | Sai thì sửa |
|---|---|---|---|
| Bết đen | % điểm ảnh có Y < 4/255 | ≤ 1,0% | `tone.lift` ↑ hoặc `tone.contrast` bớt âm |
| Cháy sáng | % điểm ảnh có Y > 251/255 | ≤ 0,8% | `bloom.brightness` ↓, `bloom.amount` ↓, `bloom.highlightCutoff` ↓ |
| Tương quan da / nền | độ sáng trung bình vùng da so với phần còn lại | da ≥ phông | hạ sáng phông, hoặc `bloom.amount` ↑ |
| Độ ấm | trung bình (đỏ − lam) toàn ảnh | 10…35 | < 5 lạnh → `warm.temp` ↑; > 45 ngả gạch → `warm.temp` ↓ |
| Sắc da | trung bình (lục − trung bình đỏ/lam) **chỉ trên vùng da** | −10…+5 | > +8 ám lục → `warm.tint` ↓; < −15 ám tím → `warm.tint` ↑ |

Sắc da đo riêng trên vùng da chứ không trên cả khung: phông xanh hay backdrop
màu sẽ kéo lệch hẳn con số nếu tính cả ảnh.

Lưu ý khi đọc `--selftest`: ảnh kiểm tổng hợp **cố tình** chứa cả mảng đen kịt
lẫn đốm cháy sáng để đo được hai đầu dải, nên hai dòng đầu hầu như luôn cảnh
báo. Muốn chấm thật thì chạy `--preview` trên một tấm ảnh chụp thật.

### Muốn mạnh hơn / nhẹ hơn

| Muốn gì | Sửa gì |
|---|---|
| Da sáng và mịn hơn | `bloom.amount` ↑ (0.7 → 0.85) |
| Quầng nở rộng hơn | `bloom.radiusPct` ↑ (tính theo **chiều ngang** ảnh) |
| Da bừng sáng hơn | `bloom.brightness` ↑ (1.35 → 1.5) |
| Phông vẫn bị loè | `bloom.highlightCutoff` ↓ (0.863 → 0.8) |
| Mềm cả khung hình, kể cả phông | `softFocus.amount` ↑ từ 0 (thử 0.2) |
| Ethereal hơn, bạc màu hơn | `tone.lift` ↑, `tone.contrast` âm hơn |
| Ấm hơn | `warm.temp` ↑ |
| Hạt rõ hơn | `grain.amount` ↑ (0.014 → 0.025; trên 0.03 bắt đầu ra đốm màu) |
| Hạt to / thô hơn (chất 8mm) | `grain.sizePx` ↑ (1.4 → 3) |
| Hạt hết đốm màu | `grain.chroma` ↓, hoặc `grain.mono: true` |
| Hạt lấn cả vùng tối | `grain.shadowRolloff` ↑ |
| Chỉ cần chống đứt dải, không cần thấy hạt | `grain.amount` ≈ 0.006 |
| Tắt hẳn hiệu ứng | `"enabled": false` |

### Nếu dslrBooth gọi cả trên file template đã ghép

Làm mềm cả tờ in sẽ nhoè luôn khung và logo. Xem trong log những đường dẫn nào
thực sự được đưa vào, rồi chặn bằng:

```json
"skip": { "pathContains": ["\\prints\\", "_final"] }
```

---

## Mang sang máy khác

**`softlight.exe` chỉ là cầu nối ~7KB, không phải chương trình.** Nó không chứa
Node.js, không chứa sharp, không chứa bộ xử lý. Chép riêng file exe sang máy
khác thì chắc chắn không chạy.

Một máy booth cần đủ **bốn** thứ:

| Thứ | Ở đâu | Thiếu thì sao |
|---|---|---|
| `softlight.exe` | cạnh mọi thứ khác | dslrBooth không gọi được |
| `src\` | cùng thư mục với exe | log báo "THIEU src\cli.js" |
| `node_modules\` (33MB) | cùng thư mục với exe | log báo "THIEU thu muc node_modules" |
| **Node.js trên máy** | cài sẵn, hoặc `node/node.exe` cạnh exe | log báo `khong chay duoc Node ... The system cannot find the file specified` |

### Cách làm

```bat
:: Trên máy gốc:
dong-goi.bat          :: tạo thư mục _deploy chứa đúng những gì cần
:: Zip _deploy, chép sang máy booth, giải nén

:: Trên máy booth:
kiem-tra.bat          :: bấm đúp, nó nói ngay thiếu gì
```

`kiem-tra.bat` kiểm tra từng mắt xích theo đúng thứ tự mà `softlight.exe` đi
qua — phiên bản Node, sharp có nạp được không, quyền ghi, cấu hình — và nói rõ
phải làm gì để sửa.

### Nếu máy booth không được cài Node.js

Tải bản Windows **zip** (không phải .msi) từ nodejs.org, giải nén, chép
`node.exe` vào thư mục con `node\` cạnh `softlight.exe`:

```
softlight.exe
node
ode.exe        <-- launcher tự ưu tiên dùng bản này
srcnode_modules```

Khi đó cả thư mục là một khối tự chứa, chép đi đâu cũng chạy.

### Vài lưu ý dễ vấp

- **Đừng giải nén vào `C:\Program Files`** — cần quyền ghi để ghi đè ảnh và ghi
  log. Dùng `C:ilmong-softlight` chẳng hạn.
- **Lần chạy đầu sau khi chép thường chậm gấp 2–3 lần** vì Windows Defender quét
  33MB `node_modules` mới. Từ lần thứ hai trở đi mới là tốc độ thật.
- **Nếu thư mục gốc nằm trong OneDrive**, bật "Always keep on this device" trước
  khi zip, kẻo zip phải file rỗng.
- **`node-path.txt` đừng chép sang máy khác** nếu nó trỏ tới đường dẫn chỉ có
  trên máy gốc. Xoá nó đi, launcher sẽ tự tìm Node.

### Khi có sự cố, xem log trước

Mọi thất bại đều được ghi vào `logs\softlight.log` kèm lý do cụ thể. Trước kia
chương trình hỏng trong im lặng (chạy ở chế độ winexe nên không có cửa sổ nào để
báo); nay launcher bắt cả `stderr` của Node và ghi lại.

---

## An toàn dữ liệu

- Ảnh gốc luôn được chép sang thư mục con `_original/` **trước** khi ghi đè.
- Sự tồn tại của bản backup chính là dấu hiệu "đã xử lý": gọi lặp không làm ảnh
  bị mờ chồng mờ.
- Khoá nguyên tử (`open` cờ `wx`) chặn hai tiến trình cùng xử lý một ảnh. Khoá
  cũ quá 2 phút được coi là rác và bỏ qua.
- Ghi ra file tạm rồi mới đổi tên đè lên. Đổi tên là thao tác nguyên tử, nên
  dslrBooth không bao giờ đọc phải một file JPEG viết dở.
- Mọi lỗi đều thoát mã 0 và chỉ ghi log — một sự cố hậu kỳ không được phép làm
  gián đoạn phiên chụp của khách. Launcher tự huỷ tiến trình con nếu quá 60s.

Trả ảnh gốc về chỗ cũ:

```bat
node src\cli.js --restore "C:\dslrBooth\Photos\2026-08-28"
```

---

## Xử lý hàng loạt (ảnh đã chụp từ trước)

```bat
node src\cli.js --dir "C:\dslrBooth\Photos\2026-08-28"
```

Ảnh đã có backup sẽ được bỏ qua. Thêm `--force` để xử lý lại từ đầu — chạy trên
ảnh đã xử lý sẽ **cộng dồn** hiệu ứng, nên nhớ `--restore` trước.

---

## Sự cố thường gặp

**Không chắc thiếu gì**
Bấm đúp `kiem-tra.bat`, hoặc `node src\cli.js --doctor`.

**Log không có dòng nào sau khi chụp**
Chạy tay để kiểm tra, nếu lỗi sẽ hiện ngay:
`node src\cli.js --file "C:\đường\dẫn\ảnh.jpg"`
Nếu lệnh này chạy được mà qua dslrBooth thì không, khả năng cao là `node` không
nằm trong PATH của tiến trình dslrBooth → tạo `node-path.txt`.

**Ảnh bị mờ quá / đục**
`--restore`, hạ `bloom.amount` (và `softFocus.amount` / `clarity.amount` nếu bạn
đã bật chúng), rồi `--preview` lại.

**Khung và logo trên tờ in bị mờ**
dslrBooth đang gọi cả trên file template. Dùng `skip.pathContains` ở trên.

**`sharp` cài lỗi trên máy booth**
Máy booth cần mạng lúc chạy `npm install` để tải binary dựng sẵn. Cài xong thì
chạy offline được.

**`build-exe.bat` báo không tìm thấy csc.exe**
Máy thiếu .NET Framework 4 (rất hiếm). Cài .NET Framework 4.8 rồi chạy lại.

---

## Cấu trúc

```
softlight.exe             điểm vào cho dslrBooth, bộ lọc Soft Light
instax.exe                điểm vào cho dslrBooth, bộ lọc Instax Wide
softlight.config.json     tham số Soft Light — sửa tay, không cần build lại
instax.config.json        tham số Instax Wide — sửa tay, không cần build lại
build-exe.bat             biên dịch CẢ HAI launcher bằng csc.exe của Windows
dong-goi.bat              tạo thư mục _deploy để chép sang máy booth
kiem-tra.bat              bấm đúp trên máy booth: kiểm tra môi trường cả hai bộ lọc
tools/Launcher.cs         nguồn của launcher — một nguồn, nhiều exe

src/cli.js                điều phối lời gọi và các lệnh thủ công (dùng chung)
src/filters/registry.js   sổ đăng ký bộ lọc — thêm bộ lọc mới là thêm một mục ở đây
src/config.js             đọc + kẹp cấu hình Soft Light
src/pipeline.js           sáu tầng của Soft Light + các phép đo kiểm chứng
src/filters/instax/config.js    đọc + kẹp cấu hình Instax Wide
src/filters/instax/pipeline.js  các tầng của Instax Wide + bài kiểm riêng

logs/softlight.log        nhật ký của bộ lọc Soft Light
logs/instax.log           nhật ký của bộ lọc Instax Wide

web/index.html            TRANG HUB — đi tới trang chỉnh của từng bộ lọc
web/hub.html              nguồn của trang hub
web/tuner.html            nguồn trang chỉnh Soft Light
web/softlight-tuner.html  bản bấm đúp là chạy, dựng từ file trên
web/instax.html           nguồn trang chỉnh Instax Wide
web/instax-tuner.html     bản bấm đúp là chạy, dựng từ file trên
web/build-offline.mjs     dựng lại các bản bấm đúp (npm run web)

_old-web-overlay/         công cụ overlay PNG cũ, giữ lại phòng khi cần
```

---

## Bộ lọc Instax Wide

Mô phỏng chất phim lấy liền. Khác Soft Light về bản chất: Soft Light làm việc
trên **không gian** — dựng các lớp mờ rồi ghép chồng; Instax làm việc trên
**sắc độ** — mọi tầng đều là phép biến đổi từng điểm ảnh. Vì vậy nó chạy nhanh
hơn và không bao giờ làm mềm chi tiết.

### Các tầng, theo đúng thứ tự

| # | Tầng | Làm gì | Tham số | Mặc định |
|---|---|---|---|---|
| 1 | Phơi sáng | Dời cả biểu đồ, để các tầng sau đọc đúng vùng sáng | `colour.exposure` | 0 |
| 2 | **Vibrance** | Đẩy rực màu **có chọn lọc** — chỉ màu đang nhạt | `colour.vibrance` | **0.35** |
| 3 | Tương phản | Neo ở điểm giữa, rồi **kẹp về 0…255** | `colour.contrast` | 0.25 |
| 4 | **Matte** | Nâng đáy tối lên khỏi 0 — vệt "sương" của phim lấy liền | `film.matte` | **0.18** |
| 5 | Tách tông | Lam-lục ở bóng đổ, kem ấm ở vùng sáng | `film.warmHighlight`, `film.shadowCyan` | 0.12 / 0.15 |
| 6 | Hạt phim | Cùng cỗ máy hạt với Soft Light, mặc định hạt xám | `grain.*` | 0.022 |

Mọi con số là **dạng chuẩn hoá = số trên thanh trượt chia 100**: `vibrance: 0.35`
chính là "Vibrance +35" trên giao diện.

### Vì sao vibrance chứ không phải saturation

Saturation đẩy đều mọi màu, và tông da vốn đã bão hoà sẵn nên nó cháy đỏ trước
tiên. Vibrance cân theo trọng số `(1 − độ bão hoà hiện tại)`: màu đang nhạt được
đẩy mạnh, màu đã rực gần như miễn nhiễm. `--selftest` đo đúng điều này — trên ảnh
kiểm, riêng tầng vibrance đẩy ô màu nhạt **+8,3%** bão hoà trong khi ô đã rực chỉ
**+0,1%**.

### Một chỗ cố ý lệch khỏi bản tham chiếu

Bản tham chiếu HTML giữ số thực suốt chuỗi, không kẹp giữa các tầng. Điều đó
**nuốt mất tầng matte ở đúng chỗ matte tồn tại để phục vụ**: tương phản 25 đẩy
mức 0 xuống −27, rồi matte cộng +18 vào đó vẫn ra số âm, nên đen kịt vẫn là đen
kịt — trái hẳn lời hứa của thanh trượt "nâng đáy tối", và bết đen thì in ra rất
xấu.

Ở đây giá trị được **kẹp về 0…255 ngay sau tầng tương phản**, đúng như mọi phép
tương phản 8-bit thật. Kết quả: mức 0 ra `(18, 23, 32)` — đáy đen hơi ngả lam,
đúng chất Instax. Đây là chỗ **duy nhất** lệch khỏi bản tham chiếu, và trang
tuner lệch y hệt nên hai bên vẫn khớp nhau.

### Hai bộ số dựng sẵn

- **Mô phỏng film** — mặc định, dành cho ảnh xem trên màn hình và bản digital.
- **Bù sáng để in** — `vibrance 0.10 · exposure 0.22 · contrast −0.08 · matte 0 ·
  warmHighlight −0.04 · shadowCyan 0 · grain 0`. Máy in Instax ăn tối hơn màn
  hình khoảng nửa khẩu và tự đẩy màu, nên bản đưa đi in phải sáng hơn và nhạt hơn
  bản để xem.

Bấm nút tương ứng trong trang chỉnh để nạp.

### Lệnh riêng

```bash
npm run selftest:instax                      # kiểm chứng bằng số đo
npm run preview:instax -- anh.jpg            # ảnh so sánh, KHÔNG ghi đè
node src/cli.js --filter instax --doctor     # kiểm tra môi trường
node src/cli.js --filter instax --dir thu-muc
```

`--selftest` của bộ lọc này in thêm **đường cong sắc độ** (mức xám vào → ra ở
0, 32, 64, 128, 192, 255). Đó là chỗ đọc nhanh nhất xem đáy đen đã rời khỏi 0
chưa và điểm trắng còn nguyên không — hai thứ quyết định ảnh in ra có bết đen
hay cháy trắng, mà nhìn bằng mắt trên màn hình thì không thấy.

---

## Thêm một bộ lọc mới

1. Viết `src/filters/<id>/config.js` (mặc định + kẹp miền giá trị) và
   `src/filters/<id>/pipeline.js` (hàm render).
2. Thêm **một mục** vào `src/filters/registry.js`. Không phải sửa `cli.js` —
   backup, khoá, log, trigger, ghi file nguyên tử đều dùng chung.
3. Thêm `call :build <id>` vào `build-exe.bat`. Launcher tự đọc tên file exe của
   chính nó để biết chạy bộ lọc nào, nên không phải sửa `tools/Launcher.cs`.
4. Làm trang chỉnh `web/<id>.html`, khai báo trong `web/build-offline.mjs`, rồi
   thêm một thẻ vào `web/hub.html`.

Mục tuỳ chọn nhưng nên có: hàm `selftest(cfg)` và `verdicts(m)` trong pipeline
của bộ lọc, khai báo trong registry — để `--selftest` và bảng hài hoà của
`--preview` nói đúng tên khoá cấu hình của bộ lọc đó.
