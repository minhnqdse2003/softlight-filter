# filmong-softlight

Hậu kỳ **Soft Light** cho dslrBooth. Chạy trên máy booth, được dslrBooth gọi ở
mục **Post-Processing**, xử lý ghi đè lên chính file ảnh — nên hiệu ứng có mặt
trên cả bản in lẫn bản digital.

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

`--selftest` phải in ra **ĐẠT** ở cả năm dòng. Nếu không, dừng lại và xử lý
trước khi cắm vào dslrBooth.

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
| 24MP (6000×4000) | ~930ms | ~460ms | **~1.4s** |
| 20MP (5472×3648) | ~880ms | ~460ms | ~1.3s |
| 12MP (4000×3000) | ~550ms | ~460ms | **~1.0s** |

Đo trên máy booth của bạn: `node src\cli.js --bench <ảnh thật>`

Nếu quá chậm, xử lý theo thứ tự hiệu quả giảm dần:

1. Hạ độ phân giải chụp trong dslrBooth — đòn bẩy mạnh nhất, thời gian tỉ lệ
   thẳng với số điểm ảnh.
2. Hạ `output.quality` xuống 90.
3. Giữ `softFocus.amount` và `clarity.amount` ở 0 (mặc định) — mỗi tầng bật
   thêm là một lượt làm mờ toàn ảnh nữa.

---

## Chỉnh tham số

### Cách nhanh: bảng chỉnh trong trình duyệt

Bấm đúp `web/softlight-tuner.html`. Thả một tấm ảnh vào, kéo slider, nhìn ngay
kết quả trên chính tấm ảnh đó, rồi bấm **Sao chép** để lấy về đúng
`softlight.config.json` đầy đủ — dán đè lên file cũ là xong.

Toàn bộ chạy trong trình duyệt, ảnh không đi đâu cả. Trang này dựng lại đúng
năm tầng của `src/pipeline.js`, kể cả cách ghép tay lớp bloom (bỏ nhân alpha
trước khi áp brightness/contrast); đối chiếu với `sharp` thật thì sai lệch
trung bình 2,2/255 (0,9%) ở bộ tham số đang dùng — phần dư đến từ box blur xấp
xỉ Gauss và từ việc pipeline làm mờ ở độ phân giải rút gọn.

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

In ra bảng năm chỉ số kèm diễn biến qua từng tầng. Quy tắc đọc quan trọng nhất:
**mức thay đổi trên vùng da phải lớn hơn hẳn mức thay đổi trên phông** — dòng
cuối bảng in thẳng tỉ lệ đó, cần ít nhất 3 lần. Nếu tỉ lệ tụt xuống thì phông
đang bị loè cùng với da: kiểm tra `bloom.skinOnly` và hạ `bloom.highlightCutoff`.

Những chỉ số chỉ có nghĩa khi tầng tương ứng được bật (độ nét, clarity, độ ấm)
sẽ hiện dấu `—` ở cột kết quả thay vì chấm đạt / không đạt.

Với cấu hình mặc định: độ sáng +32%, tương phản tổng thể −27%, mức thay đổi
trên da gấp ~10 lần trên phông.

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
softlight.exe             điểm vào cho dslrBooth (tạo bởi build-exe.bat)
softlight.config.json     tham số hiệu ứng — sửa tay, không cần build lại
build-exe.bat             biên dịch launcher bằng csc.exe của Windows
dong-goi.bat              tạo thư mục _deploy để chép sang máy booth
kiem-tra.bat              bấm đúp trên máy booth: kiểm tra môi trường
tools/Launcher.cs         nguồn của launcher
src/config.js             đọc + kẹp cấu hình về miền an toàn
src/pipeline.js           năm tầng hiệu ứng + các phép đo kiểm chứng
src/cli.js                điều phối lời gọi và các lệnh thủ công
logs/softlight.log        nhật ký, dùng để kiểm chứng
web/tuner.html            bảng chỉnh tham số trong trình duyệt (nguồn)
web/softlight-tuner.html  bản bấm đúp là chạy, dựng từ file trên
web/build-offline.mjs     dựng lại bản bấm đúp sau khi sửa tuner.html
_old-web-overlay/         công cụ overlay PNG cũ, giữ lại phòng khi cần
```
