package net.kyori.adventure.text;

import net.kyori.adventure.text.event.HoverEventSource;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;

/** Yalnız derleme stub'ı. */
public interface Component extends HoverEventSource<Component> {
    static TextComponent empty() {
        throw new UnsupportedOperationException("compile stub");
    }

    static TextComponent text(String content) {
        throw new UnsupportedOperationException("compile stub");
    }

    static TextComponent text(String content, TextColor color, TextDecoration... decorations) {
        throw new UnsupportedOperationException("compile stub");
    }
}
