package net.kyori.adventure.text;

import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEventSource;

/** Yalnız derleme stub'ı. Dönüş tipleri Adventure'daki silinmiş (erasure) imzalarla aynıdır. */
public interface TextComponent extends Component {
    Component clickEvent(ClickEvent event);

    Component hoverEvent(HoverEventSource<?> source);
}
