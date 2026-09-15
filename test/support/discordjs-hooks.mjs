/**
 * Test yükleyici kancası: bot testleri npm install olmadan koşar. discord.js
 * statik import eden modüller (components.js gibi) test edilirken paket, aynı
 * adları sunan minimal bir taklide çözülür.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'discord.js') {
    return { url: new URL('./discordjs-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
