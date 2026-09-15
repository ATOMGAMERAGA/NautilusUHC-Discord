/**
 * discord.js'in testte kullanılan yüzeyinin taklidi. Builder'lar akıcı API'yi
 * kayıt ederek sunar; enum benzeri nesneler her anahtar için sabit bir değer döner.
 */

function chain(target = {}) {
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args) => {
        for (const arg of args) {
          if (typeof arg === 'function') arg(chain({ toJSON() { return { ...this }; } }));
        }
        if (prop.startsWith('set') && args.length) {
          t[prop.charAt(3).toLowerCase() + prop.slice(4)] = args[0];
        }
        return proxy;
      };
    },
  });
  return proxy;
}

function builder() {
  return class {
    constructor(data = {}) {
      return chain({ ...data, toJSON() { return { name: this.name, description: this.description }; } });
    }
  };
}

const constants = (valueFor) => new Proxy({}, { get: (_, prop) => valueFor(prop) });

export const SlashCommandBuilder = builder();
export const ModalBuilder = builder();
export const TextInputBuilder = builder();
export const ActionRowBuilder = builder();
export const ButtonBuilder = builder();
export const StringSelectMenuBuilder = builder();
export const AttachmentBuilder = builder();

export class EmbedBuilder {
  constructor() { this.data = {}; }
  setColor(v) { this.data.color = v; return this; }
  setTitle(v) { this.data.title = v; return this; }
  setDescription(v) { this.data.description = v; return this; }
  setThumbnail(url) { this.data.thumbnail = { url }; return this; }
  setImage(url) { this.data.image = { url }; return this; }
  setFooter(v) { this.data.footer = v; return this; }
  setTimestamp(t = new Date()) { this.data.timestamp = t.toISOString?.() ?? t; return this; }
  setAuthor(v) { this.data.author = v; return this; }
  setURL(v) { this.data.url = v; return this; }
  addFields(...fields) {
    this.data.fields = (this.data.fields ?? []).concat(fields.flat());
    return this;
  }
}

export class Client {}

export const MessageFlags = { Ephemeral: 64 };
export const TextInputStyle = { Short: 1, Paragraph: 2 };
export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 };
export const PermissionFlagsBits = constants(() => 1n);
export const ChannelType = constants(() => 0);
export const Events = constants((prop) => String(prop));
export const GatewayIntentBits = constants(() => 0);
export const Partials = constants(() => 0);
export const ActivityType = constants(() => 0);
export const AuditLogEvent = constants(() => 0);
