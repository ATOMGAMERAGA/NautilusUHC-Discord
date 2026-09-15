package com.nautilus.discordlink;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Köprü sözleşmesi için bağımlılıksız ve sınırlı JSON okuyucu/yazıcı.
 *
 * Sayılar BigDecimal okunur; böylece yanlışlıkla sayı olarak gelen büyük bir
 * Discord ID'si hassasiyet kaybetmez (API zaten yalnız string ID kabul eder).
 */
public final class LinkJson {
    private static final int MAX_DEPTH = 16;
    private static final int MAX_LENGTH = 256_000;

    private LinkJson() {
    }

    public static Map<String, Object> parseObject(String text) {
        if (text == null || text.isBlank()) return new LinkedHashMap<>();
        if (text.length() > MAX_LENGTH) throw new IllegalArgumentException("JSON gövdesi çok büyük");
        Parser parser = new Parser(text);
        Object value = parser.readValue(0);
        parser.skipWhitespace();
        if (!parser.atEnd()) throw new IllegalArgumentException("JSON sonunda fazladan veri");
        if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException("JSON nesnesi bekleniyordu");
        @SuppressWarnings("unchecked")
        Map<String, Object> object = (Map<String, Object>) map;
        return object;
    }

    public static String write(Object value) {
        StringBuilder out = new StringBuilder();
        writeValue(out, value, 0);
        return out.toString();
    }

    private static void writeValue(StringBuilder out, Object value, int depth) {
        if (depth > MAX_DEPTH) throw new IllegalStateException("JSON çok derin");
        if (value == null) {
            out.append("null");
        } else if (value instanceof String string) {
            writeString(out, string);
        } else if (value instanceof UUID uuid) {
            writeString(out, uuid.toString());
        } else if (value instanceof Boolean bool) {
            out.append(bool.booleanValue() ? "true" : "false");
        } else if (value instanceof BigDecimal decimal) {
            out.append(decimal.toPlainString());
        } else if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                out.append("null");
            } else {
                out.append(BigDecimal.valueOf(number).toPlainString());
            }
        } else if (value instanceof Number number) {
            out.append(number.toString());
        } else if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) out.append(',');
                first = false;
                writeString(out, String.valueOf(entry.getKey()));
                out.append(':');
                writeValue(out, entry.getValue(), depth + 1);
            }
            out.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) out.append(',');
                first = false;
                writeValue(out, item, depth + 1);
            }
            out.append(']');
        } else {
            writeString(out, value.toString());
        }
    }

    private static void writeString(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static final class Parser {
        private final String text;
        private int index;

        Parser(String text) {
            this.text = text;
        }

        boolean atEnd() {
            return this.index >= this.text.length();
        }

        void skipWhitespace() {
            while (!atEnd()) {
                char c = this.text.charAt(this.index);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    this.index++;
                } else {
                    return;
                }
            }
        }

        Object readValue(int depth) {
            if (depth > MAX_DEPTH) throw new IllegalArgumentException("JSON çok derin");
            skipWhitespace();
            if (atEnd()) throw new IllegalArgumentException("JSON beklenmedik şekilde bitti");
            char c = this.text.charAt(this.index);
            return switch (c) {
                case '{' -> readObject(depth);
                case '[' -> readArray(depth);
                case '"' -> readString();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> readNumber();
            };
        }

        private Map<String, Object> readObject(int depth) {
            Map<String, Object> object = new LinkedHashMap<>();
            this.index++;
            skipWhitespace();
            if (peek('}')) {
                this.index++;
                return object;
            }
            while (true) {
                skipWhitespace();
                if (!peek('"')) throw new IllegalArgumentException("JSON anahtarı bekleniyordu");
                String key = readString();
                skipWhitespace();
                expect(':');
                object.put(key, readValue(depth + 1));
                skipWhitespace();
                if (peek(',')) {
                    this.index++;
                    continue;
                }
                expect('}');
                return object;
            }
        }

        private List<Object> readArray(int depth) {
            List<Object> array = new ArrayList<>();
            this.index++;
            skipWhitespace();
            if (peek(']')) {
                this.index++;
                return array;
            }
            while (true) {
                array.add(readValue(depth + 1));
                skipWhitespace();
                if (peek(',')) {
                    this.index++;
                    continue;
                }
                expect(']');
                return array;
            }
        }

        private String readString() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (true) {
                if (atEnd()) throw new IllegalArgumentException("JSON dizgisi kapanmadı");
                char c = this.text.charAt(this.index++);
                if (c == '"') return out.toString();
                if (c == '\\') {
                    if (atEnd()) throw new IllegalArgumentException("JSON kaçış dizisi eksik");
                    char escape = this.text.charAt(this.index++);
                    switch (escape) {
                        case '"' -> out.append('"');
                        case '\\' -> out.append('\\');
                        case '/' -> out.append('/');
                        case 'b' -> out.append('\b');
                        case 'f' -> out.append('\f');
                        case 'n' -> out.append('\n');
                        case 'r' -> out.append('\r');
                        case 't' -> out.append('\t');
                        case 'u' -> {
                            if (this.index + 4 > this.text.length()) {
                                throw new IllegalArgumentException("JSON unicode kaçışı eksik");
                            }
                            String hex = this.text.substring(this.index, this.index + 4);
                            try {
                                out.append((char) Integer.parseInt(hex, 16));
                            } catch (NumberFormatException error) {
                                throw new IllegalArgumentException("JSON unicode kaçışı geçersiz", error);
                            }
                            this.index += 4;
                        }
                        default -> throw new IllegalArgumentException("JSON kaçış dizisi geçersiz");
                    }
                } else if (c < 0x20) {
                    throw new IllegalArgumentException("JSON dizgisinde kontrol karakteri");
                } else {
                    out.append(c);
                }
            }
        }

        private BigDecimal readNumber() {
            int start = this.index;
            while (!atEnd()) {
                char c = this.text.charAt(this.index);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
                    this.index++;
                } else {
                    break;
                }
            }
            if (start == this.index) throw new IllegalArgumentException("JSON değeri geçersiz");
            try {
                return new BigDecimal(this.text.substring(start, this.index));
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("JSON sayısı geçersiz", error);
            }
        }

        private Object literal(String word, Object value) {
            if (!this.text.startsWith(word, this.index)) throw new IllegalArgumentException("JSON değeri geçersiz");
            this.index += word.length();
            return value;
        }

        private boolean peek(char c) {
            return !atEnd() && this.text.charAt(this.index) == c;
        }

        private void expect(char c) {
            if (!peek(c)) throw new IllegalArgumentException("JSON '" + c + "' bekleniyordu");
            this.index++;
        }
    }
}
