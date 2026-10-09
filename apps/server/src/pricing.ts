/**
 * Đơn giá token theo model - USD trên MỘT TRIỆU token.
 *
 * DÙNG ĐỂ LÀM GÌ: bảng "Chi phí AI theo model" trên Dashboard cần tách riêng
 * tiền của token VÀO và token RA. Bảng `token_usage` chỉ lưu MỘT con số
 * `costUsd` gộp cả hai (Agent SDK trả về `total_cost_usd`), nên không tách
 * ngược ra được từ dữ liệu - phải suy ra bằng tỉ lệ.
 *
 * BẢNG GIÁ NÀY LÀ TỈ LỆ, KHÔNG PHẢI SỐ TIỀN - đọc kỹ chỗ này:
 * `routes/usage.ts` dùng đơn giá ở đây để tính TRỌNG SỐ giữa chiều vào và chiều
 * ra, rồi chia đúng số tiền THẬT theo trọng số đó. Nên $vào + $ra luôn bằng
 * `costUsd`.
 *
 * KHÔNG được quay lại cách nhân thẳng token × đơn giá để ra tiền. Đã thử và
 * hỏng: prompt cache đọc lại chỉ tính khoảng 10% giá vào, nên số nhân ra cao
 * gấp mấy lần tiền thật - bảng hiện $2.055 cạnh $402 trong cùng một hàng và
 * người dùng báo ngay là sai. Giá niêm yết trả lời được câu "chiều nào tốn hơn",
 * nhưng không trả lời được câu "hết bao nhiêu tiền".
 *
 * Giá Claude lấy từ bảng model chính thức (skill `claude-api`, bản 2026-06-24),
 * KHÔNG phải nhớ ra. Có model mới thì cập nhật ở đây, đừng đoán.
 */

/** USD/1 triệu token. */
export interface ModelPrice {
  inPerM: number;
  outPerM: number;
}

/**
 * Khóa là id model đúng như lúc ghi vào `chat_sessions.model`.
 * Model không có trong bảng này thì API trả `price: null` và UI để trống ô $,
 * chứ KHÔNG bịa một con số gần đúng.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ----- Anthropic -----
  "claude-fable-5-1": { inPerM: 10, outPerM: 50 },
  "claude-opus-5-5": { inPerM: 4, outPerM: 20 },
  "claude-sonnet-5-5": { inPerM: 2, outPerM: 10 },
  // Giá cho prompt tới 100K token; dài hơn là 0.5/2.5 - bảng này chỉ giữ một
  // mức nên lấy mức thường gặp, số tiền thật vẫn lấy từ costUsd của SDK
  "claude-haiku-5-5": { inPerM: 0.1, outPerM: 0.5 },
  "claude-fable-5": { inPerM: 10, outPerM: 50 },
  "claude-mythos-5": { inPerM: 10, outPerM: 50 },
  "claude-opus-5": { inPerM: 5, outPerM: 25 },
  "claude-opus-4-8": { inPerM: 5, outPerM: 25 },
  "claude-opus-4-7": { inPerM: 5, outPerM: 25 },
  "claude-opus-4-6": { inPerM: 5, outPerM: 25 },
  // Sonnet 5 đang có giá giới thiệu 2/10 tới hết 31/08/2026; để giá NIÊM YẾT
  // ở đây vì đây là bảng giá chuẩn, còn số tiền thật vẫn lấy từ costUsd.
  "claude-sonnet-5": { inPerM: 3, outPerM: 15 },
  "claude-sonnet-4-6": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },

  // ----- Google Gemini -----
  // Trùng với hằng số đã dùng để TÍNH costUsd trong stt.ts và translate.ts
  // (GEMINI_PRICE_IN_PER_M / _OUT_PER_M) - hai nơi phải bằng nhau, lệch là
  // cột tổng và cột $vào/$ra đá nhau vì lý do sai chứ không phải vì cache.
  "gemini-3.1-flash-image": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-3.1-flash-lite-image": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-3-pro-image": { inPerM: 0.3, outPerM: 2.5 },
};

/**
 * Đơn giá mặc định theo NHÀ CUNG CẤP - dùng khi dòng token_usage không gắn với
 * phiên chat nào nên không biết model (bóc lời, dịch, tạo ảnh… chạy ngoài phiên).
 * Riêng Claude cố ý KHÔNG có mặc định: khoảng giá của nó quá rộng (1 → 50
 * USD/1M) nên đoán bừa là sai hẳn một bậc, thà để trống.
 */
export const PROVIDER_FALLBACK_PRICES: Record<string, ModelPrice> = {
  gemini: { inPerM: 0.3, outPerM: 2.5 },
};

/** Đơn giá của một dòng usage; null = không biết, UI phải để trống ô $. */
export function priceFor(
  model: string | null,
  provider: string | null,
): ModelPrice | null {
  if (model && MODEL_PRICES[model]) return MODEL_PRICES[model];
  if (provider && PROVIDER_FALLBACK_PRICES[provider]) {
    return PROVIDER_FALLBACK_PRICES[provider];
  }
  return null;
}
