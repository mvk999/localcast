# LocalCast

Espelhamento de tela do notebook para o navegador de uma Smart TV, somente pela rede local.

> LocalCast foi projetado para funcionar exclusivamente na rede local e não utiliza STUN, TURN, servidores cloud ou signaling externo.

## Arquitetura

```text
Notebook (sender)                         Smart TV (receiver)
http://localhost:8000                     http://IPv4-LAN:8000/tv
getDisplayMedia(), após clique            navegador recebe vídeo
          |                                         |
          +----- WebSocket local para signaling ----+
          +----- WebRTC direto, ICE host only ------+
```

O processo Node abre dois sockets HTTP separados na porta `8000`:

- `127.0.0.1`: somente sender e WebSocket sender;
- um IPv4 privado da LAN: somente página TV e WebSocket receiver.

Não há bind em `0.0.0.0`, IPv6, UPnP, NAT-PMP, port forwarding, STUN, TURN ou relay. O `RTCPeerConnection` usa `iceServers: []`, e o signaling aceita apenas candidatos ICE `host` adequados para a LAN selecionada (ou nomes mDNS `.local` emitidos pelo navegador).

## Requisitos

- Linux com Node.js 18 ou superior e npm;
- notebook e TV na mesma sub-rede IPv4 privada;
- Chrome/Chromium moderno no notebook;
- navegador da TV com WebSocket e `RTCPeerConnection` para receber WebRTC;
- Wi-Fi sem isolamento entre clientes.

## Instalação e execução

```bash
npm install
npm start
```

Exemplo de saída:

```text
LocalCast iniciado.

No notebook: http://localhost:8000
Na TV:       http://192.168.1.20:8000/tv
```

Abra a primeira URL somente no notebook. Abra a URL da TV no navegador da TV. Se houver mais de uma interface privada elegível, LocalCast não escolhe silenciosamente: informe uma explicitamente.

```bash
npm start -- --host 192.168.1.20
```

O host informado deve ser um IPv4 privado ativo do notebook. Por padrão são ignorados `docker`, bridges, `veth`, VPN/TUN/TAP, Tailscale, WireGuard, VirtualBox e interfaces semelhantes. A seleção normal usa a interface da rota padrão do kernel, mas a consulta da rota não faz contato com a Internet.

## Fluxo de pareamento

1. A TV abre `/tv`; o servidor cria uma sessão em memória e mostra um PIN aleatório de seis dígitos.
2. O PIN expira após dois minutos, é de uso único e não é escrito nos logs.
3. Digite o PIN em `http://localhost:8000` no notebook e escolha **Conectar**.
4. A TV passa a autorizada. Somente então o botão **Compartilhar tela** fica disponível.
5. Ao clicar no botão, o navegador pede a escolha nativa de tela, janela ou aba. Antes desse gesto não existe captura ativa.
6. O sender cria a oferta WebRTC e a TV recebe o vídeo ocupando a tela.
7. **Parar transmissão**, encerrar a página sender ou desconectar a TV para os tracks, fecha o peer connection, encerra WebSockets e invalida a sessão. A TV cria um PIN novo.

O sender limita cinco PINs incorretos por conexão local; após isso a página deve ser recarregada. Esse limite protege a tentativa de pareamento, mas a página sender é deliberadamente acessível apenas por loopback, não pela LAN.

## Modelo de segurança

A confirmação humana é o PIN exibido fisicamente na TV. Uma página de outro dispositivo na LAN pode criar a própria sessão TV, mas não consegue abrir a página sender ou enviar uma oferta sem que alguém no notebook digite o PIN dela em `localhost`.

O receiver é servido por HTTP porque muitos navegadores de TV não permitem instalar ou confiar facilmente em um certificado HTTPS local. A página sender usa `localhost`, que navegadores modernos tratam como contexto confiável para `getDisplayMedia()`. A TV não captura mídia, apenas recebe WebRTC. O transporte de mídia WebRTC é protegido por DTLS-SRTP, mas o signaling HTTP/WebSocket do MVP não é criptografado: uma LAN maliciosa continua fora do modelo de ameaça doméstico. Use Wi-Fi protegido e não trate LocalCast como solução contra invasores já presentes na rede.

O servidor ainda restringe HTTP e WebSocket ao mesmo subnet IPv4 da interface LAN selecionada. Isso reduz exposição por VPN e rotas paralelas; não substitui firewall do sistema nem segmentação de rede. Nunca exponha a porta 8000 por encaminhamento no roteador.

## Dados que saem da rede

Nenhum. LocalCast não faz requests para cloud, analytics, autenticação externa, STUN, TURN, servidores de signaling remotos ou telemetria. Com a WAN do roteador desconectada, o fluxo deve permanecer funcional desde que a LAN continue operante.

O navegador pode usar resolução mDNS local para candidatos ICE mascarados por privacidade. Isso é multicast da LAN, não acesso à Internet. Navegadores podem enumerar candidatos host de interfaces adicionais; LocalCast filtra candidatos numéricos para a interface/sub-rede esperada, mas não consegue mapear um nome mDNS a uma interface antes da resolução. Esses candidatos continuam locais e não criam relay ou descoberta externa.

## Limitações e compatibilidade

- O maior risco técnico é o navegador da TV. Algumas TVs antigas não têm WebRTC, WebSocket, decodificador de vídeo compatível ou política de autoplay adequada. A página `/tv` informa ausência básica de WebSocket/WebRTC; o teste definitivo é fazer um cast real na TV.
- O MVP envia vídeo e não captura áudio. Áudio de compartilhamento varia muito entre navegadores e será avaliado somente após validar o vídeo.
- Não há suporte a IPv6 no MVP. Isso é intencional para evitar anunciar endereço global sem uma análise própria.
- Sem STUN/TURN, notebook e TV precisam poder trocar UDP/TCP diretamente. Isolamento de clientes, VLANs separadas ou firewall local podem impedir a conexão.
- Em desktops Chrome/Chromium, `getDisplayMedia()` requer gesto explícito e contexto seguro. Firefox pode funcionar, mas deve ser testado separadamente.
- Em alguns ambientes Linux, o portal de captura ou Wayland pode limitar as fontes disponíveis; isso é controlado pelo navegador/sistema, não por LocalCast.

Referências de plataforma: [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [MDN contextos confiáveis](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) e [MDN conectividade WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity).

## Testes

```bash
npm test
```

Os testes automatizados cobrem seleção de interface segura, PIN inválido/expirado, uso único e a distinção entre expiração curta do PIN e sessão ativa. Antes de considerar o MVP pronto, execute também este roteiro manual na TV:

| Verificação | Resultado esperado |
| --- | --- |
| TV aberta sem PIN digitado | sem vídeo e sem offer WebRTC |
| PIN errado | sender mostra recusa |
| PIN expirado | sender mostra recusa e TV renova sessão |
| PIN já usado | recusa |
| seis PINs errados | sender bloqueia novas tentativas até recarregar |
| outro dispositivo acessa a URL | só pode ver sua própria tela de PIN, nunca vídeo |
| WAN desligada | pareamento e vídeo continuam pela LAN |
| inspeção de rede | nenhuma conexão STUN/TURN/cloud; apenas notebook, TV e multicast mDNS local se usado |
| Parar transmissão | vídeo some, tracks terminam, sessão TV recebe PIN novo |

Para um teste inicial sem TV, abra `http://IP-DA-LAN:8000/tv` em um segundo navegador/dispositivo e execute todo o fluxo. Isso prova notebook para browser receiver, mas não substitui validar o navegador específico da TV.

## Troubleshooting

- **A TV não abre a página:** confirme que ela está na mesma sub-rede, que o firewall local permite TCP 8000 vindo da LAN e que a URL inclui `/tv`.
- **LocalCast pede `--host`:** escolha o IPv4 Wi-Fi/Ethernet desejado mostrado pelo sistema, nunca Docker/VPN.
- **PIN não conecta:** recarregue a TV para gerar outro PIN e confira os seis dígitos. Um PIN antigo não pode ser reaproveitado.
- **TV fica em Conectando vídeo:** confirme que não há isolamento Wi-Fi de clientes e que o navegador da TV implementa WebRTC. Teste primeiro outro browser/dispositivo na mesma LAN.
- **Compartilhamento não abre:** use `http://localhost:8000` exatamente no notebook, em Chrome/Chromium atualizado, e verifique permissões do navegador/sistema.
- **Vídeo não inicia na TV:** use o controle para permitir reprodução se solicitado; alguns navegadores de TV aplicam política de autoplay própria.

## Roadmap curto

1. Validar o receiver em uma TV real e registrar modelo/navegador testado.
2. Ajustar compatibilidade de codec e latência somente se a TV exigir.
3. Avaliar áudio opcional após o vídeo estar estável.
4. Considerar HTTPS local somente se o navegador da TV permitir uma experiência de certificado aceitável.
