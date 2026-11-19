# Sổ Kho

Ứng dụng web quản lý **nhập – xuất – tồn kho** gọn nhẹ, chạy offline trên điện thoại và máy tính. Quản lý hàng hóa theo tên, kèm ảnh chụp trực tiếp từ camera điện thoại.

- Tồn kho tự tính, cảnh báo sắp hết / hết hàng
- Phiếu nhập, phiếu xuất có số lượng, đơn giá, thời gian, ghi chú
- Lịch sử giao dịch theo ngày, tìm kiếm, xóa phiếu ghi nhầm
- Ảnh hàng hóa chụp từ camera hoặc chọn từ thư viện, tự nén trước khi lưu
- Sao lưu / khôi phục toàn bộ dữ liệu ra file JSON
- Cài lên màn hình chính (PWA), dùng offline sau lần tải đầu

Dữ liệu được lưu trong trình duyệt của từng thiết bị (IndexedDB), không gửi lên máy chủ.

## Bản chạy

- GitHub Pages: `https://<tên-tài-khoản>.github.io/so-kho/`

## Chạy thử trên máy

Cần một máy chủ tĩnh (không mở trực tiếp `index.html` bằng `file://`):

```bash
py -m http.server 8137
```

Mở `http://localhost:8137`.

## Cập nhật

Sau khi sửa code, tăng `?v=` của `styles.css`/`app.js` trong `index.html` và tăng `CACHE` trong `sw.js`, rồi tải lại các file lên repo.
