# LocalCast

Espelhamento de tela para o navegador de uma Smart TV usando apenas a rede local.

## Estado inicial

O primeiro marco é um PoC real de `notebook → WebRTC → navegador da TV`. A compatibilidade do receiver depende do navegador/modelo da TV e precisa ser confirmada no aparelho; não há como inferi-la só pelo notebook.

## Decisões do MVP

- Node.js, HTML/CSS/JavaScript e WebSocket local; sem framework de frontend.
- WebRTC com `iceServers: []`: sem STUN, TURN ou relay.
- Sender em `http://localhost:8000`, para que a captura de tela possa usar o contexto confiável de localhost.
- Receiver em `http://<IPv4-LAN>:8000/tv`.
- Dois binds explícitos na mesma porta: `127.0.0.1` e um único IPv4 privado da LAN. Não há bind em `0.0.0.0` nem IPv6 no MVP.
- A interface LAN é obtida pela rota padrão do kernel e exclui, por padrão, Docker, VPNs, Tailscale, WireGuard e interfaces virtuais. Em caso ambíguo o programa exige `--host`.
- Sessões são apenas em memória; PIN criptograficamente aleatório, temporário e de uso único.

## Limitações que precisam ser aceitas

- `getDisplayMedia()` precisa de gesto do usuário e de um contexto confiável. Localhost costuma ser tratado como confiável, mas HTTP no IP da LAN não é; por isso a TV nunca captura tela.
- Um browser de TV antigo pode não implementar WebRTC, decodificador/códec compatível ou WebSocket. O PoC mostrará um diagnóstico básico, mas o teste definitivo é abrir `/tv` na TV.
- Sem STUN/TURN, a conexão depende de notebook e TV conseguirem comunicação direta na mesma LAN. Wi‑Fi com isolamento de clientes impede o uso.
- Browsers podem anunciar candidatos ICE host via mDNS e em mais de uma interface. O projeto não configura nenhum servidor ICE e nunca cria candidatos reflexivos/relay; o bind HTTP e o signaling ficam limitados ao IPv4 LAN selecionado.

## Segurança proposta

Uma TV só recebe um offer WebRTC depois de exibir fisicamente um PIN e ele ser digitado na página local do notebook. A captura não inicia até o botão **Compartilhar tela** gerar a solicitação nativa do navegador. O serviço não configura UPnP, port forwarding ou IPv6 e não chama serviços externos.

Isso é segurança proporcional a uma LAN doméstica, não substitui Wi‑Fi protegido nem isola dispositivos já comprometidos no notebook.

## Próximos passos

1. Servidor PoC e páginas sender/receiver.
2. Pareamento, signaling e captura após autorização.
3. Testes de segurança e validação no navegador da TV.
