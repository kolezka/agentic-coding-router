# Strumienie Responses

W buforowanych ścieżkach ai-gateway kolektor czeka na koniec body HTTP.
Jeśli upstream wysłał już `response.completed`, ale pozostawia body otwarte,
klient może nadal czekać na gotową odpowiedź. Same heartbeaty mogą także
podtrzymywać timeout transportowy mimo braku postępu odpowiedzi.
Te zachowania są odtwarzane w testach z lokalnym serwerem HTTP.

CCR opakowuje body przed przekazaniem go kolektorowi. Ochrona obejmuje tylko
udane odpowiedzi `text/event-stream` na endpointach Responses skonfigurowanych
providerów `openai_responses`. Dopasowanie uwzględnia origin i ścieżkę URL.

- Bajty zdarzeń do terminala pozostają niezmienione, także dla dzielonego UTF-8.
- `response.completed`, `response.incomplete` i `[DONE]` kończą body oraz anulują
  dalszy odczyt upstreamu. Dane po terminalu są odrzucane.
- `response.failed` i `error` kończą odczyt błędem zamiast udanym EOF.
  Nie powoduje to ponownego wysłania żądania przez guard.
- Brak postępu może zakończyć odczyt błędem również wtedy, gdy napływają heartbeaty.

## API_STREAM_IDLE_TIMEOUT_MS

Opcjonalne pole konfiguracji aplikacji, obok `API_TIMEOUT_MS`.
Nie zmienia dotychczasowego timeoutu transportowego.

| Wartość | Zachowanie |
| --- | --- |
| Brak | Dziedziczy `API_TIMEOUT_MS`, domyślnie 600000 ms. |
| Dodatnia liczba lub tekst liczbowy | Ustawia budżet braku postępu w milisekundach. |
| `0` lub `"0"` | Wyłącza watchdog, ale zachowuje zakończenie po terminalu. |
| Pusty tekst, whitespace, wartość ujemna, nieliczbowa lub powyżej 24 godzin | Wraca do poprawnego `API_TIMEOUT_MS`, a przy jego braku lub niepoprawnej wartości wyłącza watchdog. |

Budżet obejmuje oczekiwanie na pierwszy postęp oraz przerwy między kolejnymi
zdarzeniami postępu. Nie jest limitem czasu całej odpowiedzi. Niepuste delty
tekstu, reasoning, odmowy oraz argumentów i wejścia narzędzi zerują licznik.
Komentarze SSE, `ping` i zdarzenia cyklu życia odpowiedzi lub narzędzi nie
zerują licznika, ponieważ mogą powtarzać się bez rzeczywistego postępu.

Model wykonujący długie, niewidoczne reasoning może przekroczyć ten budżet.
Dla takiego modelu można zwiększyć wartość lub jawnie wyłączyć watchdog.
Backpressure wolnego klienta pauzuje licznik, zamiast udawać zastój modelu.
Pojedyncza ramka większa niż 16 MiB powoduje jawny błąd limitu skanera.
