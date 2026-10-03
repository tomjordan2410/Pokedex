const pokemonApiUrl = "https://pokeapi.co/api/v2/pokemon/"
const searchInput = document.querySelector("#search")
const searchButton = document.querySelector("#searchBtn")
const errorMessage = document.querySelector(".error-message")
const pokemonStatus = document.querySelector("#pokemon-status")
const randomButton = document.querySelector(".randomise")
const form = document.querySelector("#form")
const loader = document.querySelector(".loader")
const mainContainer = document.querySelector(".main-container")
const pokemonView = document.querySelector("#pokemon-view")
const savedSection = document.querySelector("#saved-pokemon-section")
const savedList = document.querySelector("#saved-pokemon-list")
const savedStatus = document.querySelector("#saved-pokemon-status")
const savedHeading = document.querySelector("#saved-pokemon-heading")
const savedLink = document.querySelector("#saved-pokemon-link")
const backButton = document.querySelector("#back-to-pokedex")
const previousButton = document.querySelector(".previous")
const nextButton = document.querySelector(".next")
let currentID = 1
let pokemonRequest = 0
let pokemonController
let comparisonController
let savedListIsTemporary = false
const storageNotice = document.querySelector("#storage-notice")
let interactionVersion = 0

// ? Listens for user interactions to increment a version counter, which is used to determine if a request is still relevant when it completes.
// ?  Keeps UI focus and state consistent even if the user navigates away or interacts with the page while a request is in progress.
for (const eventName of ["focusin", "input", "pointerdown"]) {
    document.addEventListener(eventName, () => interactionVersion++)
}

const statDefinitions = [
    ["hp", "HP"],
    ["attack", "Attack"],
    ["defense", "Defense"],
    ["special-attack", "Special Attack"],
    ["special-defense", "Special Defense"],
    ["speed", "Speed"]
]

function displayName(name) {
    return name.replace(/-/g, " ")
}

// ? Referencing normalising the search to match API expectations - saves you repeating this in multiple places and ensures consistency.
function normaliseSearch(value) {
    return String(value).trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "-")
}

// ? Cache successful responses for this visit and share simultaneous requests.
const responseCache = new Map()
const pendingRequests = new Map()
// ? Cache lifetime and request timeout are set to reasonable values to balance performance and freshness of data.
const requestTimeoutMs = 10000
const cacheLifetimeMs = 24 * 60 * 60 * 1000
const cacheLimit = 200

// ? Creates a new fetch request with an abort controller and timeout, caching the response if successful.
function abortError() {
    return new DOMException("Request cancelled.", "AbortError")
}

// ? Creates an object containing a fetch promise, and handles aborting and caching. It also manages subscribers to the request, allowing multiple callers to share the same request.
// ? Requests are shared to avoid duplicate network calls for the same resource, and the cache is used to return data quickly if it's still valid.
function createRequest(resourceUrl) {
    const controller = new AbortController()
    const entry = { controller, subscribers: new Set(), timedOut: false }
    const timer = setTimeout(() => {
        entry.timedOut = true
        controller.abort()
    }, requestTimeoutMs)
    entry.promise = (async () => {
        try {
            const response = await fetch(resourceUrl, { signal: controller.signal })
            if (!response.ok) {
                const error = new Error("Request failed.")
                error.status = response.status
                throw error
            }
            const data = await response.json()
            if (controller.signal.aborted) throw abortError()
            responseCache.delete(resourceUrl)
            responseCache.set(resourceUrl, { data, expires: Date.now() + cacheLifetimeMs })
            if (responseCache.size > cacheLimit) responseCache.delete(responseCache.keys().next().value)
            return data
        } catch (error) {
            if (entry.timedOut) {
                const timeout = new Error("The request timed out. Please try again.")
                timeout.name = "TimeoutError"
                throw timeout
            }
            throw error
        } finally {
            clearTimeout(timer)
            if (pendingRequests.get(resourceUrl) === entry) pendingRequests.delete(resourceUrl)
        }
    })()
    pendingRequests.set(resourceUrl, entry)
    return entry
}

// ? Fetches JSON data which other functions use to get API data.
// ? First checks cache, then checks for pending requests, and finally makes a new request if necessary. It also handles aborting requests and cleaning up subscribers.
function fetchJson(resourceUrl, message, signal) {
    if (signal?.aborted) return Promise.reject(abortError())
    const cached = responseCache.get(resourceUrl)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.data)
    responseCache.delete(resourceUrl)
    const entry = pendingRequests.get(resourceUrl) ?? createRequest(resourceUrl)
    return new Promise((resolve, reject) => {
        const subscriber = {}
        entry.subscribers.add(subscriber)
        const cleanup = () => {
            signal?.removeEventListener("abort", cancel)
            entry.subscribers.delete(subscriber)
        }
        const cancel = () => {
            cleanup()
            reject(abortError())
            // Keep a shared request alive if another caller still needs it.
            if (!entry.subscribers.size) {
                if (pendingRequests.get(resourceUrl) === entry) pendingRequests.delete(resourceUrl)
                entry.controller.abort()
            }
        }
        signal?.addEventListener("abort", cancel, { once: true })
        entry.promise.then(data => {
            cleanup()
            resolve(data)
        }, error => {
            cleanup() // Choosing what error to reject with.
            if (error.name === "AbortError" || error.name === "TimeoutError") reject(error)
            else if (error.status === 404 && resourceUrl.startsWith(pokemonApiUrl)) reject(new Error("No Pokémon found. Please try again."))
            else reject(new Error(`${message} Please check your connection and try again.`))
        })
    })
}
// ? Normalises the search term and fetches the Pokémon data from the API, throwing an error if the term is empty or invalid.
async function runSearch(value = searchInput.value, signal) {
    const term = normaliseSearch(value)
    if (!term) throw new Error("Enter a Pokémon name or number.")
    return fetchJson(pokemonApiUrl + encodeURIComponent(term), "Unable to load Pokémon.", signal)
}

form.addEventListener("submit", event => {
    event.preventDefault()
    return loadPokemon(searchInput.value)
})

// ? Loads the Pokémon data and updates the UI accordingly. It handles aborting previous requests, showing loading states, and managing focus. It also saves the search term to history and loads additional details asynchronously.
async function loadPokemon(value, { random = false } = {}) {
    const request = ++pokemonRequest
    pokemonController?.abort()
    comparisonController?.abort()
    pokemonController = new AbortController()
    const signal = pokemonController.signal // cancel previous Pokemon request and comparison request.
    closeSuggestions()
    showPokemonView()
    mainContainer.replaceChildren() // Prepare page for new content.
    const startedAt = interactionVersion // Tracks interaction (focus, input, pointerdown) version to determine if the request is still relevant when it completes.
    searchButton.disabled = true
    loader.hidden = false
    mainContainer.setAttribute("aria-busy", "true")
    errorMessage.textContent = ""
    pokemonStatus.textContent = random ? "Loading a random Pokémon…" : "Loading Pokémon…" // Sets "loading" status and disables the search button.

    const canMoveFocus = () => !pokemonView.hidden && interactionVersion === startedAt
    try {
        const pokemon = await runSearch(value, signal)
        if (request !== pokemonRequest) return
        const view = buildPokemonView(pokemon)
        // Commit navigation state only after the complete view has been built.
        const navigationRow = document.createElement("div")
        navigationRow.classList.add("pokemon-navigation")
        navigationRow.append(previousButton, view.overview, nextButton)
        mainContainer.replaceChildren(navigationRow, view.comparison)
        closeSuggestions()
        currentID = pokemon.id
        previousButton.hidden = false
        nextButton.hidden = false
        previousButton.disabled = currentID <= 1
        nextButton.disabled = currentID >= 1025
        mainContainer.setAttribute("aria-busy", "false")
        saveSearch(pokemon.name)
        if (canMoveFocus()) view.heading.focus()
        pokemonStatus.textContent = `${displayName(pokemon.name)} loaded. Additional details are loading.`
        // Optional panels update independently; the main card is already usable.
        loadPokemonDetails(pokemon, view, signal, () => request === pokemonRequest)
            .catch(() => { /* Individual panels already show their own fallback. */ })
    } catch (error) {
        if (request !== pokemonRequest) return
        errorMessage.textContent = error.message
        pokemonStatus.textContent = ""
        if (canMoveFocus()) (random ? randomButton : searchInput).focus()
    } finally {
        // An older request must not reset a newer request's loading state.
        if (request === pokemonRequest) {
            searchButton.disabled = false
            loader.hidden = true
            mainContainer.setAttribute("aria-busy", "false")
        }
    }
}
// ? Loads additional Pokémon details (description, evolution, weaknesses, abilities) asynchronously and updates the UI accordingly. It checks if the request is still relevant before updating the UI to avoid race conditions.
async function loadPokemonDetails(pokemon, view, signal, isCurrent) {
    const canUpdate = () => !signal.aborted && isCurrent() // Returns true if the request is still relevant and not aborted, allowing UI updates to proceed.
    const speciesTask = (async () => {
        let species
        try {
            species = await fetchJson(pokemon.species.url, "Description unavailable.", signal) // Fetches species data to get the Pokémon description and evolution chain.
            const entry = species.flavor_text_entries.find(item => item.language.name === "en") // Find English description.
            if (canUpdate()) view.description.textContent = entry 
                ? entry.flavor_text.replace(/\u00ad\s*/g, "").replace(/[\n\f\r]+/g, " ")
                : "No description available." // If entry exists, clean up the text; otherwise, show a fallback message.
        } catch {
            if (canUpdate()) view.description.textContent = "Description unavailable." // Show a fallback message if fetching species data fails.
        } finally {
            if (canUpdate()) view.description.setAttribute("aria-busy", "false") // Mark the description panel as no longer busy, allowing screen readers to announce the updated content.
        }
        try { // ! Fetch evolution data and species data separately to avoid unnecessary requests if the species data is already cached, and to handle cases where the evolution chain may not be available.
            if (!species?.evolution_chain?.url) throw new Error("Evolution unavailable.")
            const chain = await fetchJson(species.evolution_chain.url, "Evolution details unavailable.", signal)
            const evolution = await buildEvolutionChart(chain.chain, signal)
            if (canUpdate()) {
                const list = document.createElement("ul")
                list.appendChild(evolution)
                view.evolutionContent.replaceChildren(list)
            }
        } catch {
            if (canUpdate()) view.evolutionContent.textContent = "Evolution details unavailable."
        } finally {
            if (canUpdate()) view.evolutionPanel.setAttribute("aria-busy", "false")
        }
    })()
    const weaknessesTask = (async () => { 
        let weaknesses = null // Initialize weaknesses to null to indicate that they are not yet loaded or unavailable.
        try { weaknesses = await loadWeaknesses(pokemon.types, signal) } catch {}
        if (canUpdate()) {
            view.weaknessesContent.replaceChildren(buildWeaknessesList(weaknesses)) // Replace the weaknesses content with the newly built list of weaknesses, or a fallback message if they are unavailable.
            view.weaknessesPanel.setAttribute("aria-busy", "false")
        }
    })()
    const abilitiesTask = Promise.all(pokemon.abilities.map(async (item, index) => { // Load each ability's explanation asynchronously and update the corresponding UI element when available.
        const ability = await loadAbility(item, signal)
        if (canUpdate()) view.abilityTexts[index].textContent = ability.explanation
    })).then(() => {
        if (canUpdate()) view.abilityItem.setAttribute("aria-busy", "false")
    })
    await Promise.all([speciesTask, weaknessesTask, abilitiesTask]) // Wait for all tasks to complete before proceeding, ensuring that all details are loaded and the UI is updated accordingly.
    if (canUpdate()) {
        pokemonStatus.textContent = `${displayName(pokemon.name)} details finished loading.`
    }
}

async function loadWeaknesses(types, signal) { // Load weaknesses via types, and add signal to allow response to cancellation. 
    const typeData = await Promise.all(types.map(item => fetchJson(item.type.url, "Weaknesses unavailable.", signal))) // Using map to fetch each type of data (for two type Pokemon).
    return calculateWeaknesses(typeData)
}

function calculateWeaknesses(typeData) {
    const multipliers = {}
    for (const type of typeData) {
        for (const [relation, factor] of [["double_damage_from", 2], ["half_damage_from", 0.5], ["no_damage_from", 0]]) {
            for (const attackingType of type.damage_relations[relation]) {
                multipliers[attackingType.name] = (multipliers[attackingType.name] ?? 1) * factor
            }
        }
    }
    return Object.entries(multipliers).filter(([, multiplier]) => multiplier > 1)
}

async function loadAbility(item, signal) {
    let explanation = "Ability explanation unavailable."
    try {
        const data = await fetchJson(item.ability.url, explanation, signal)
        explanation = data.effect_entries.find(entry => entry.language.name === "en")?.short_effect
            ?? data.flavor_text_entries.find(entry => entry.language.name === "en")?.flavor_text
            ?? "No explanation available."
    } catch {
        // The ability name remains useful even when its explanation is unavailable.
    }
    return { name: item.ability.name, explanation }
}

function buildListItem(text) {
    const item = document.createElement("li")
    item.classList.add("list-group-item")
    item.textContent = text
    return item
}

function buildTypeImage(typeName) {
    const image = document.createElement("img")
    image.src = `images/${typeName}.png`
    image.alt = typeName
    image.classList.add("type-icon")
    return image
}

function buildArtwork(pokemon, className, decorative = false) {
    const image = document.createElement("img")
    image.classList.add(className)
    image.alt = decorative ? "" : displayName(pokemon.name)
    const sprite = pokemon.sprites?.front_default
    const artwork = pokemon.sprites?.other?.["official-artwork"]?.front_default
    image.addEventListener("error", () => {
        if (sprite && image.getAttribute("src") !== sprite) {
            image.src = sprite
        } else {
            image.hidden = true
        }
    })
    if (artwork || sprite) image.src = artwork || sprite
    else image.hidden = true
    return image
}

function buildStatsList(pokemon) {
    const statsList = document.createElement("ul")
    statsList.classList.add("list-group", "list-group-flush")
    for (const [key, label] of statDefinitions) {
        const value = pokemon.stats.find(item => item.stat.name === key)?.base_stat
        const statItem = buildListItem(`${label}: ${value ?? "Unavailable"}`)
        if (value !== undefined) {
            const meter = document.createElement("progress")
            meter.max = 255
            meter.value = value
            meter.setAttribute("aria-label", statItem.textContent)
            statItem.appendChild(meter)
        }
        statsList.appendChild(statItem)
    }
    return statsList
}

function buildWeaknessesList(weaknesses) {
    const list = document.createElement("div")
    list.classList.add("weaknesses-list")
    if (weaknesses === null) list.textContent = "Weaknesses unavailable."
    else if (!weaknesses.length) list.textContent = "None"
    else for (const [typeName, multiplier] of weaknesses) {
        const weakness = document.createElement("span")
        weakness.classList.add("weakness")
        weakness.append(buildTypeImage(typeName), ` (${multiplier}×) `)
        list.appendChild(weakness)
    }
    return list
}

function buildPokemonView(pokemon) {
    const pokemonCard = document.createElement("div")
    pokemonCard.classList.add("item-container", "card", "card-body")
    const heading = document.createElement("h2")
    heading.classList.add("name", "card-title", "text-primary", "capitalise")
    heading.textContent = displayName(pokemon.name)
    heading.tabIndex = -1
    const description = document.createElement("p")
    description.classList.add("card-text")
    description.textContent = "Loading description…"
    description.setAttribute("aria-busy", "true")
    const detailsList = document.createElement("ul")
    detailsList.classList.add("list-group", "list-group-flush")
    const typeItem = buildListItem("Type: ")
    for (const item of pokemon.types) typeItem.appendChild(buildTypeImage(item.type.name))
    const abilityItem = buildListItem("Abilities:")
    const abilityTexts = []
    abilityItem.setAttribute("aria-busy", "true")
    for (const item of pokemon.abilities) {
        const ability = item.ability
        const explanation = document.createElement("details")
        explanation.classList.add("ability-details")
        const summary = document.createElement("summary")
        summary.textContent = displayName(ability.name)
        const text = document.createElement("p")
        text.textContent = "Loading explanation…"
        abilityTexts.push(text)
        explanation.append(summary, text)
        abilityItem.appendChild(explanation)
    }
    detailsList.append(
        buildListItem(`Pokedex ID: #${pokemon.id}`),
        buildListItem(`Height: ${pokemon.height / 10} m`),
        buildListItem(`Weight: ${pokemon.weight / 10} kg`),
        typeItem,
        buildListItem(`Base Exp: ${pokemon.base_experience ?? "Unavailable"}`),
        abilityItem
    )
    pokemonCard.append(buildArtwork(pokemon, "card-img-top"), heading, buildAddToListButton(pokemon), description, detailsList)
    const evolutionContent = document.createElement("div")
    evolutionContent.textContent = "Loading evolution…"
    const evolutionPanel = buildDetailPanel("Evolution", evolutionContent)
    evolutionPanel.classList.add("evolution-panel")
    evolutionPanel.setAttribute("aria-busy", "true")
    const weaknessesContent = document.createElement("div")
    weaknessesContent.textContent = "Loading weaknesses…"
    const weaknessesPanel = buildDetailPanel("Weaknesses", weaknessesContent)
    weaknessesPanel.setAttribute("aria-busy", "true")
    const overview = document.createElement("div")
    overview.classList.add("pokemon-overview")
    const statsPanel = buildDetailPanel("Base stats", buildStatsList(pokemon))
    overview.append(pokemonCard, weaknessesPanel, statsPanel, evolutionPanel)
    return { overview, heading, description, abilityItem, abilityTexts, weaknessesContent,
        weaknessesPanel, evolutionContent, evolutionPanel, comparison: buildComparisonSection(pokemon) }
}

function buildDetailPanel(title, content) {
    const panel = document.createElement("section")
    panel.classList.add("detail-panel", "card", "card-body")
    const heading = document.createElement("h2")
    heading.classList.add("h5")
    heading.textContent = title
    panel.append(heading, content)
    return panel
}

function buildComparisonSection(pokemon) {
    const section = document.createElement("section")
    section.classList.add("comparison-section", "card", "card-body")

    const heading = document.createElement("h2")
    heading.classList.add("h5")
    heading.textContent = "Compare Pokémon"

    const comparisonForm = document.createElement("form")
    comparisonForm.classList.add("comparison-form")

    const label = document.createElement("label")
    label.htmlFor = "compare-search"
    label.textContent = "Find another Pokémon by name or number"

    const input = document.createElement("input")
    input.type = "text"
    input.id = "compare-search"
    input.required = true
    input.classList.add("form-control")
    input.placeholder = "e.g. Pikachu or 25"
    const searchField = document.createElement("div")
    searchField.classList.add("search-field")
    const suggestionList = document.createElement("ul")
    suggestionList.id = "compare-suggestions"
    suggestionList.classList.add("search-suggestions")
    suggestionList.setAttribute("aria-label", "Comparison Pokémon suggestions")
    suggestionList.hidden = true
    searchField.append(input, suggestionList)
    attachSuggestions(input, suggestionList)

    const button = document.createElement("button")
    button.type = "submit"
    button.classList.add("btn", "btn-primary")
    button.textContent = "Compare"

    const status = document.createElement("p")
    status.classList.add("comparison-status")
    status.setAttribute("role", "status")

    const results = document.createElement("details")
    results.classList.add("comparison-results")
    results.hidden = true
    let comparisonRequest = 0

    const resetComparison = () => {
        comparisonRequest++
        comparisonController?.abort()
        results.replaceChildren()
        results.hidden = true
        results.open = false
        results.setAttribute("aria-busy", "false")
        status.textContent = ""
        button.disabled = false
    }
    input.addEventListener("input", resetComparison)

    comparisonForm.addEventListener("submit", async (event) => {
        event.preventDefault()
        closeSuggestions()
        if (button.disabled) return
        const request = ++comparisonRequest
        comparisonController?.abort()
        const controller = new AbortController()
        comparisonController = controller
        button.disabled = true
        status.textContent = "Loading comparison…"
        results.replaceChildren()
        results.hidden = true
        results.setAttribute("aria-busy", "true")

        try {
            const otherPokemon = await runSearch(input.value, controller.signal)
            if (request !== comparisonRequest || controller.signal.aborted) return
            if (otherPokemon.id === pokemon.id) {
                throw new Error("Choose a different Pokémon to compare.")
            }
            const summary = document.createElement("summary")
            summary.textContent = `${pokemon.name.replace(/-/g, " ")} vs ${otherPokemon.name.replace(/-/g, " ")}`
            summary.classList.add("capitalise")
            results.replaceChildren(summary, buildComparisonTable(pokemon, otherPokemon))
            results.hidden = false
            results.open = true
            status.textContent = "Comparison loaded."
        } catch (error) {
            if (request === comparisonRequest && !controller.signal.aborted) status.textContent = error.message
        } finally {
            if (request === comparisonRequest) {
                button.disabled = false
                results.setAttribute("aria-busy", "false")
            }
        }
    })

    comparisonForm.append(label, searchField, button)
    section.append(heading, comparisonForm, status, results)
    return section
}

function buildComparisonTable(first, second) {
    const table = document.createElement("table")
    table.classList.add("table", "table-bordered", "comparison-table")

    const caption = document.createElement("caption")
    caption.textContent = "General information and base stats. Higher base stats are highlighted."

    const head = document.createElement("thead")
    const headerRow = document.createElement("tr")
    const detailHeading = document.createElement("th")
    detailHeading.scope = "col"
    detailHeading.textContent = "Detail"
    headerRow.appendChild(detailHeading)

    for (const pokemon of [first, second]) {
        const cell = document.createElement("th")
        cell.scope = "col"
        const name = document.createElement("span")
        name.classList.add("capitalise")
        name.textContent = pokemon.name.replace(/-/g, " ")
        cell.appendChild(buildArtwork(pokemon, "comparison-artwork", true))
        cell.appendChild(name)
        headerRow.appendChild(cell)
    }

    head.appendChild(headerRow)
    const body = document.createElement("tbody")
    const addRow = (label, values, highlight = false) => {
        const row = document.createElement("tr")
        const heading = document.createElement("th")
        heading.scope = "row"
        heading.textContent = label
        row.appendChild(heading)
        for (const value of values) {
            const cell = document.createElement("td")
            cell.textContent = value
            if (highlight && values[0] !== values[1] && value === Math.max(...values)) {
                cell.classList.add("table-success", "fw-bold")
            }
            row.appendChild(cell)
        }
        body.appendChild(row)
    }

    const pokemon = [first, second]
    addRow("Pokédex ID", pokemon.map(p => `#${p.id}`))
    addRow("Height", pokemon.map(p => `${p.height / 10} m`))
    addRow("Weight", pokemon.map(p => `${p.weight / 10} kg`))
    addRow("Types", pokemon.map(p => p.types.map(item => item.type.name).join(" / ")))
    for (const [key, label] of statDefinitions) {
        addRow(label, pokemon.map(p => p.stats.find(item => item.stat.name === key)?.base_stat ?? "Unavailable"), true)
    }
    addRow("Total base stats", pokemon.map(p => p.stats.reduce((total, item) => total + item.base_stat, 0)), true)

    table.append(caption, head, body)
    return table
}

function randomise() {
    searchInput.value = ""
    const randomID = Math.floor(Math.random() * 1025) + 1
    return loadPokemon(randomID, { random: true })
}

randomButton.addEventListener("click", randomise)

function previous() {
    if (currentID > 1) {
        searchInput.value = currentID - 1
        form.requestSubmit()
    }
}

function next() {
    if (currentID < 1025) {
        searchInput.value = currentID + 1
        form.requestSubmit()
    }
}

previousButton.addEventListener("click", previous)
nextButton.addEventListener("click", next)

document.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, summary, [contenteditable='true']")) return

    if (event.key === "ArrowLeft" && !previousButton.hidden && !previousButton.disabled) {
        event.preventDefault()
        previous()
    } else if (event.key === "ArrowRight" && !nextButton.hidden && !nextButton.disabled) {
        event.preventDefault()
        next()
    }
})

async function buildEvolutionChart(stage, signal) {
    const speciesData = await fetchJson(stage.species.url, "Evolution species unavailable.", signal)
    const defaultVariety = speciesData.varieties.find(variety => variety.is_default)
    if (!defaultVariety) throw new Error("Evolution artwork unavailable.")
    const pokemon = await fetchJson(defaultVariety.pokemon.url, "Evolution artwork unavailable.", signal)

    const item = document.createElement("li")

    const name = document.createElement("p")
    name.textContent = stage.species.name.replace(/-/g, " ")
    name.classList.add("capitalise")

    const button = document.createElement("button")
    button.type = "button"
    button.classList.add("evolution-button")
    button.setAttribute("aria-label", `View ${name.textContent}`)

    button.appendChild(buildArtwork(pokemon, "evolution-artwork"))

    button.addEventListener("click", () => {
        searchInput.value = pokemon.name
        form.requestSubmit()
    })

    item.append(button, name)

    if (stage.evolves_to.length > 0) {
        const nextStages = document.createElement("ul")

        for (const nextStage of stage.evolves_to) {
            nextStages.appendChild(
                await buildEvolutionChart(nextStage, signal)
            )
        }

        item.appendChild(nextStages)
    }

    return item
}

const suggestions = document.querySelector("#pokemon-suggestions")
let pokemonNames = []
let suggestionsUnavailable = false
const suggestionFields = new Map()
let pokemonCatalogue = []
const historyKey = "pokedex-search-history"
let searchHistory = loadSearchHistory()

function loadSearchHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem(historyKey) ?? "[]")
        return Array.isArray(saved)
            ? [...new Set(saved.filter(name => typeof name === "string" && name.trim() !== ""))].slice(0, 8)
            : []
    } catch {
        return []
    }
}

function saveSearch(name) {
    searchHistory = [name, ...searchHistory.filter(item => item !== name)].slice(0, 8)

    try {
        localStorage.setItem(historyKey, JSON.stringify(searchHistory))
    } catch {
    }

}

async function loadPokemonNames() {
    try {
        const data = await fetchJson(pokemonApiUrl + "?limit=10000", "Unable to load suggestions.")
        pokemonCatalogue = data.results.map(pokemon => ({
            name: pokemon.name,
            id: Number(pokemon.url.split("/").filter(Boolean).pop())
        }))
        pokemonNames = pokemonCatalogue.map(pokemon => pokemon.name)
    } catch {
        suggestionsUnavailable = true
    }
    for (const [input, field] of suggestionFields) {
        if (!document.contains(input)) continue
        if (suggestionsUnavailable) field.status.textContent = "Suggestions unavailable. You can still search by name or number."
        else if (document.activeElement === input) updateSuggestions(input, field.list)
    }
}

function updateSuggestions(input = searchInput, list = suggestions) {
    const term = normaliseSearch(input.value)

    list.replaceChildren()

    const names = term === ""
        ? searchHistory
        : [...new Set([...searchHistory, ...pokemonNames])]

    const numberMatch = pokemonCatalogue.find(pokemon => String(pokemon.id) === term)?.name
    const matches = names
        .filter(name => name.startsWith(term) || name === numberMatch)
        .slice(0, 6)

    for (const name of matches) {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        const pokemon = pokemonCatalogue.find(pokemon => pokemon.name === name)
        if (pokemon) {
            const image = document.createElement("img")
            const sprite = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.id}.png`
            image.src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemon.id}.png`
            image.alt = ""
            image.loading = "lazy"
            image.addEventListener("error", () => {
                if (image.getAttribute("src") !== sprite) image.src = sprite
                else image.hidden = true
            })
            button.appendChild(image)
        }
        const label = document.createElement("span")
        label.classList.add("capitalise")
        label.textContent = name.replace(/-/g, " ")
        button.appendChild(label)
        button.addEventListener("click", () => {
            input.value = name
            input.dispatchEvent(new Event("input", { bubbles: true }))
            input.focus()
            closeSuggestions()
            input.form?.requestSubmit()
        })
        item.appendChild(button)
        list.appendChild(item)
    }
    list.hidden = matches.length === 0
    const status = suggestionFields.get(input)?.status
    if (status) {
        status.textContent = suggestionsUnavailable
            ? "Suggestions unavailable. You can still search by name or number."
            : matches.length ? `${matches.length} suggestion${matches.length === 1 ? "" : "s"} available. Press Tab or Down Arrow to browse.`
            : term ? "No matching suggestions. You can still search." : ""
    }
}

function closeSuggestions() {
    for (const [input, field] of suggestionFields) {
        if (!document.contains(input)) {
            suggestionFields.delete(input)
            continue
        }
        field.list.hidden = true
        if (!suggestionsUnavailable) field.status.textContent = ""
    }
}

function attachSuggestions(input, list) {
    // Suggestions remain ordinary, keyboard-accessible buttons.
    // Instructions and a live status explain them without partial combobox ARIA.
    const instructions = document.createElement("p")
    instructions.id = `${list.id}-help`
    instructions.classList.add("visually-hidden")
    instructions.textContent = "Type a Pokémon name or number. Use Tab or Down Arrow to reach suggestions, Enter to select, and Escape to close."
    const status = document.createElement("p")
    status.classList.add("suggestions-status")
    status.setAttribute("role", "status")
    status.setAttribute("aria-atomic", "true")
    if (suggestionsUnavailable) status.textContent = "Suggestions unavailable. You can still search by name or number."
    input.parentElement.append(instructions, status)
    suggestionFields.set(input, { list, status })
    input.autocomplete = "off"
    input.setAttribute("aria-controls", list.id)
    input.setAttribute("aria-describedby", instructions.id)
    input.addEventListener("input", () => updateSuggestions(input, list))
    input.addEventListener("focus", () => updateSuggestions(input, list))
    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown") {
            event.preventDefault()
            updateSuggestions(input, list)
            list.querySelector("button")?.focus()
        }
        if (event.key === "Escape") closeSuggestions()
    })
    list.addEventListener("keydown", event => {
        const buttons = [...list.querySelectorAll("button")]
        const index = buttons.indexOf(document.activeElement)
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            const next = index + (event.key === "ArrowDown" ? 1 : -1)
            if (next < 0) input.focus()
            else buttons[next % buttons.length]?.focus()
        }
        if (event.key === "Escape") {
            input.focus()
            closeSuggestions()
        }
    })
    input.parentElement.addEventListener("focusout", event => {
        if (!input.parentElement.contains(event.relatedTarget)) {
            list.hidden = true
            if (!suggestionsUnavailable) status.textContent = ""
        }
    })
}

attachSuggestions(searchInput, suggestions)
document.addEventListener("click", event => {
    if (!event.target.closest(".search-field")) closeSuggestions()
})

loadPokemonNames()

const savedPokemonKey = "pokedex-saved-pokemon"
let savedPokemon = loadSavedPokemon()
let persistedPokemonIDs = new Set(savedPokemon.map(pokemon => pokemon.id))
renderSavedPokemon()

savedLink.addEventListener("click", event => {
    event.preventDefault()
    closeSuggestions()
    pokemonView.hidden = true
    savedSection.hidden = false
    backButton.focus()
})
backButton.addEventListener("click", () => {
    showPokemonView()
    searchInput.focus()
})

function showPokemonView() {
    pokemonView.hidden = false
    savedSection.hidden = true
}

function loadSavedPokemon() {
    try {
        const saved = JSON.parse(localStorage.getItem(savedPokemonKey) ?? "[]")
        if (!Array.isArray(saved)) return []
        const seen = new Set()
        return saved.filter(p => {
            if (!p || !Number.isInteger(p.id) || p.id < 1 ||
                typeof p.name !== "string" || !p.name.trim() ||
                typeof p.image !== "string" || seen.has(p.id)) return false
            seen.add(p.id)
            return true
        })
    } catch {
        return []
    }
}

function buildAddToListButton(pokemon) {
    const button = document.createElement("button")
    button.type = "button"
    button.classList.add("btn", "btn-outline-primary", "add-to-list")
    button.dataset.pokemonId = pokemon.id
    button.disabled = savedPokemon.some(p => p.id === pokemon.id)
    button.textContent = button.disabled
        ? savedListIsTemporary && !persistedPokemonIDs.has(pokemon.id) ? "Added for this visit" : "Added to list"
        : "Add to list"
    button.addEventListener("click", () => {
        if (savedPokemon.some(p => p.id === pokemon.id)) return
        savedPokemon.push({ id: pokemon.id, name: pokemon.name,
            image: pokemon.sprites.other?.["official-artwork"]?.front_default
                ?? pokemon.sprites.front_default ?? "" })
        savePokemonList()
    })
    return button
}

function savePokemonList() {
    let persisted = true
    try {
        localStorage.setItem(savedPokemonKey, JSON.stringify(savedPokemon))
        persistedPokemonIDs = new Set(savedPokemon.map(pokemon => pokemon.id))
    } catch {
        persisted = false
    }
    savedListIsTemporary = !persisted
    storageNotice.textContent = persisted
        ? ""
        : "Your latest Pokémon list changes are temporary. Browser storage is unavailable, so these changes will be lost when you reload or close this page."
    renderSavedPokemon()
}

function renderSavedPokemon() {
    const list = savedList
    list.replaceChildren()
    savedLink.textContent = `My Pokémon list (${savedPokemon.length})`
    savedStatus.textContent = savedPokemon.length
        ? `${savedPokemon.length} Pokémon in your list.`
        : "Your list is empty. Find a Pokémon and choose Add to list."
    for (const pokemon of savedPokemon) {
        const item = document.createElement("li")
        item.classList.add("card", "card-body", "saved-pokemon-card")
        const name = pokemon.name.replace(/-/g, " ")
        const view = document.createElement("button")
        view.type = "button"
        view.classList.add("saved-pokemon-view")
        view.setAttribute("aria-label", `View ${name}`)
        if (pokemon.image) {
            const image = document.createElement("img")
            image.src = pokemon.image
            image.alt = ""
            image.addEventListener("error", () => { image.hidden = true })
            view.appendChild(image)
        }
        const title = document.createElement("span")
        title.classList.add("capitalise")
        title.textContent = name
        const id = document.createElement("span")
        id.textContent = `#${pokemon.id}`
        view.append(title, id)
        view.addEventListener("click", () => {
            searchInput.value = pokemon.name
            form.requestSubmit()
        })
        const remove = document.createElement("button")
        remove.type = "button"
        remove.classList.add("btn", "btn-sm", "btn-outline-danger")
        remove.textContent = "Remove"
        remove.setAttribute("aria-label", `Remove ${name} from your list`)
        remove.addEventListener("click", () => {
            const removedIndex = savedPokemon.findIndex(p => p.id === pokemon.id)
            savedPokemon = savedPokemon.filter(p => p.id !== pokemon.id)
            savePokemonList()
            const remainingButtons = list.querySelectorAll(".saved-pokemon-view")
            const nextFocus = remainingButtons[Math.min(removedIndex, remainingButtons.length - 1)]
                ?? savedHeading
            nextFocus.focus()
        })
        item.append(view, remove)
        list.appendChild(item)
    }
    for (const button of document.querySelectorAll(".add-to-list")) {
        button.disabled = savedPokemon.some(p => p.id === Number(button.dataset.pokemonId))
        button.textContent = button.disabled
            ? savedListIsTemporary && !persistedPokemonIDs.has(Number(button.dataset.pokemonId)) ? "Added for this visit" : "Added to list"
            : "Add to list"
    }
}
