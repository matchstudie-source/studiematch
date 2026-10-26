# Studiematch

Studiematch finder studiejob, der passer til den uddannelse, du læser. Det er en anbefalingsmaskine, ikke en jobsøgemaskine.

Projektet består af to dele, og begge kører gratis:

| Del | Hvad den gør | Hvor den kører |
| --- | --- | --- |
| `site/` | Selve hjemmesiden: skolevalg, uddannelsessøgning, matching, feed, gemte job. Profilen ligger kun i den studerendes egen browser. | Cloudflare Pages (gratis) |
| `collector/` | Jobindsamleren. Henter studiejob fra arbejdsgivernes egne jobsystemer to gange i døgnet, sorterer dem og skriver `site/data/jobs.json`. Virksomhedsfinderen leder hver mandag efter nye arbejdsgivere. | GitHub Actions (gratis) |

Når indsamleren gemmer nye job, bygger Cloudflare siden igen af sig selv. Du skal ikke have en server.

---

## Det skal du selv gøre (ca. 30 minutter)

### 1. Opret en GitHub-konto og læg koden op

1. Opret en gratis konto på [github.com](https://github.com/signup).
2. Hent [GitHub Desktop](https://desktop.github.com) (det er nemmest, fordi mappen `.github` er skjult i Finder på Mac).
3. Pak zip-filen ud. I GitHub Desktop: **File → Add local repository →** vælg mappen `studiematch` → **Create a repository** → **Publish repository**.
4. Lad **Keep this code private** være slået til. Det koster stadig ikke noget: en privat konto har 2.000 gratis Actions-minutter om måneden, og indsamleren bruger cirka 2 til 5 minutter pr. kørsel.

### 2. Slå automatisk jobindsamling til

1. Gå til dit repository på github.com → fanen **Settings → Actions → General**.
2. Under **Workflow permissions**: vælg **Read and write permissions** → **Save**. Så må indsamleren gemme nye job.
3. Gå til fanen **Actions** → **Find virksomheder** → **Run workflow**. Den besøger de ca. 200 arbejdsgivere i `collector/companies.csv`, finder deres jobsystem og tilføjer dem til `collector/employers.csv`. Det tager op til en time. Resultatet står i `collector/discover_report.md`.
4. Kør derefter **Hent job** → **Run workflow**. Efter et kvarter er der en rapport i `collector/report.md`, og jobbene ligger i `site/data/jobs.json`.

Begge kører derefter af sig selv. Med et privat repository bruger de omkring 1.200 af de 2.000 gratis minutter om måneden. Gør du repositoriet offentligt, er minutterne ubegrænsede.

### 3. Læg siden online med Cloudflare Pages

1. Opret en gratis konto på [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. **Workers & Pages → Create → Pages → Connect to Git** → log ind med GitHub → vælg dit repository.
3. Indstillinger:
   - Framework preset: **None**
   - Build command: *(lad den være tom)*
   - Build output directory: **`site`**
4. **Save and Deploy**. Siden ligger nu på en adresse som `studiematch.pages.dev`.

### 4. Køb domænet

Det er den eneste udgift.

- **.dk (anbefalet):** Siden 1. juli 2026 kan nye .dk-domæner kun købes gennem en registrator, ikke direkte hos Punktum dk. Vælg en dansk registrator fra [Punktum dk's liste](https://www.punktum.dk/en/registrar-list), fx Simply.com. Deres prisliste viser cirka 15 USD om året for et .dk-domæne (omkring 100 kr.), og første år er ofte billigere. Søg på navnet, og køb det for ét år.
- **.com (valgfrit):** Cloudflare Registrar sælger .com til kostpris uden avance. Køb det i Cloudflare under **Domain Registration**, hvis du også vil have det. Cloudflare sælger ikke .dk.

Tjek også, at ingen anden dansk virksomhed bruger navnet. Søg i [CVR](https://datacvr.virk.dk) og hos [Patent- og Varemærkestyrelsen](https://www.dkpto.dk).

### 5. Forbind domænet til siden

1. I Cloudflare: **Add a domain** → skriv `studiematch.dk` → vælg **Free**-planen.
2. Cloudflare viser dig to navneservere (fx `anna.ns.cloudflare.com`). Log ind hos din .dk-registrator → **Navneservere / DNS** → erstat de nuværende med Cloudflares to.
3. Tilbage i Cloudflare: **Workers & Pages →** dit projekt **→ Custom domains → Set up a domain** → skriv `studiematch.dk`. Gentag med `www.studiematch.dk`.
4. Det tager typisk fra 10 minutter til et par timer, før domænet virker. HTTPS sættes op af sig selv.

### 6. (Valgfrit) Lad AI læse jobopslagene

Uden AI sorterer indsamleren job med faste regler, og det fungerer fint. Med AI bliver felter, timer, dansk-krav og beskrivelser mere præcise.

1. Opret en nøgle på [console.anthropic.com](https://console.anthropic.com) og sæt et lille månedligt loft, fx 50 kr.
2. På github.com: **Settings → Secrets and variables → Actions → New repository secret**. Name: `ANTHROPIC_API_KEY`, værdi: din nøgle.
3. Hvert opslag læses kun én gang, fordi svaret gemmes i `collector/cache.json`. Indsamleren laver højst 200 AI-kald pr. kørsel, og det loft kan du ændre med variablen `STUDIEMATCH_MAX_AI_CALLS`.

---

## Sådan tilføjer du flere job

### Den nemme måde: `collector/companies.csv`

Skriv navn og hjemmeside på de virksomheder, du vil have med. Virksomhedsfinderen klarer resten ved næste kørsel. Den genkender Teamtailor, Greenhouse, Lever, SmartRecruiters, HR-Manager, Emply, Workday, SAP SuccessFactors og sider med strukturerede jobdata.

Står der "intet jobsystem fundet" i `collector/discover_report.md`, bruger virksomheden et system, Studiematch ikke kan læse endnu, eller også slår de kun job op på Jobindex. Så er den bedste vej at bede dem om at slå studiejob op direkte hos dig.

### Manuelt: `collector/employers.csv`

Én række pr. arbejdsgiver. Kolonnen `source` bestemmer, hvordan jobbene hentes:

| source | ref (hvad du skriver) | Eksempel |
| --- | --- | --- |
| `teamtailor` | Adressen på karrieresiden | `https://firma.teamtailor.com` |
| `greenhouse` | Board-navnet fra `boards.greenhouse.io/<navn>` | `autoproff` |
| `lever` | Navnet fra `jobs.lever.co/<navn>` | `veo` |
| `smartrecruiters` | Virksomheds-id fra `jobs.smartrecruiters.com/<id>` | `Devoteam` |
| `hrmanager` | Kundenavnet fra `hr-manager.net/…?customer=<navn>` | `regionsyddanmark` |
| `emply` | Adressen på Emply-karrieresiden | `https://regioner.career.emply.com/studentermedhjaelper` |
| `workday` | Adressen på Workday-karrieresiden | `https://firma.wd3.myworkdayjobs.com/Careers` |
| `sitemap` | Karrieresidens adresse, hvis den har et sitemap (fx SAP SuccessFactors) | `https://jobs.firma.com` |
| `careerpage` | Jobsiden, hvis den bruger standarden *JobPosting* (mange offentlige sider gør) | `https://…/ledige-stillinger` |
| `evergreen` | Et link til en ordning med løbende optag, fx et vikarkorps for sygeplejestuderende. Udfyld også `title`, `fam`, `blurb` og `src_label`. | `https://…/vikar` |

Sådan finder du ud af, hvilket system en virksomhed bruger: åbn et af deres jobopslag, og se på adressen. Står der fx `teamtailor`, `greenhouse`, `lever`, `smartrecruiters`, `hr-manager`, `emply` eller `myworkdayjobs`, kan du tilføje dem.

`region` er en af `cph` (Storkøbenhavn og Sjælland), `aar`, `ode`, `aal` eller `remote`.
`fam` er et af felterne i `collector/enrich.py` (fx `finance`, `health`, `education`, `marketing`, `software`).

### Job, som en virksomhed sender direkte: `collector/manual_jobs.csv`

Når en virksomhed mailer dig et studiejob, skriver du det ind her. Det kommer med ved næste kørsel og forsvinder selv, når fristen er passeret.

### Hvad er gået galt?

Åbn `collector/report.md` efter en kørsel. Den viser hver kilde, hvor mange job den havde, og hvor mange der var studiejob. Står der `fejl` ud for en kilde, har virksomheden sandsynligvis skiftet system. Ret eller slet rækken.

---

## Reglerne vi følger, når vi henter job

- Vi bruger kun åbne feeds og API'er, som virksomhederne selv udgiver, og sider med strukturerede jobdata.
- Vi respekterer `robots.txt` og venter et sekund mellem kald.
- Vi kopierer ikke fra jobportaler som Jobindex, LinkedIn eller StudentJob.
- Vi viser et kort resumé og linker altid til det originale opslag.
- Hos store internationale virksomheder henter vi kun studiejob i Danmark.
- HR-Managers joblister indeholder også kontaktpersoner. Dem gemmer vi ikke.

## Data om brugerne

Profilen (uddannelse, timer, sprog, gemte job) ligger kun i den studerendes egen browser. Siden har ingen database og sender ingen brugerdata nogen steder hen. Det skal ændres, når der kommer login og jobalarmer, og så skal der også skrives en privatlivspolitik.

## Kør det på din egen computer

```bash
pip install -r collector/requirements.txt
python -m unittest discover -s collector/tests -v   # test uden internet
python collector/discover.py                         # finder jobsystemer (tilføj --merge for at gemme dem)
python collector/collect.py                          # henter rigtige job
cd site && python -m http.server 8000                 # åbn http://localhost:8000
```

## Udgifter

| Post | Pris |
| --- | --- |
| Hosting (Cloudflare Pages) | 0 kr. |
| Jobindsamling (GitHub Actions) | 0 kr. |
| .dk-domæne | ca. 100 kr. om året |
| AI-læsning af opslag (valgfri) | typisk få kroner om måneden med loftet slået til |
