package main

// The JSON Schema has already checked each file's shape, so these types hold
// only the fields the integrity rules in docs/data-format.md need.

type CatalogueKind string

const (
	CatalogueKindFaction CatalogueKind = "Faction"
	CatalogueKindLibrary CatalogueKind = "Library"
)

type ConditionKind string

const (
	ConditionKindCount          ConditionKind = "Count"
	ConditionKindPrimaryFaction ConditionKind = "PrimaryFaction"
	ConditionKindAll            ConditionKind = "All"
	ConditionKindAny            ConditionKind = "Any"
	ConditionKindNot            ConditionKind = "Not"
)

type CountTargetKind string

const (
	CountTargetKindDatasheet        CountTargetKind = "Datasheet"
	CountTargetKindKeyword          CountTargetKind = "Keyword"
	CountTargetKindRole             CountTargetKind = "Role"
	CountTargetKindOption           CountTargetKind = "Option"
	CountTargetKindDetachmentChoice CountTargetKind = "DetachmentChoice"
	CountTargetKindDetachment       CountTargetKind = "Detachment"
	CountTargetKindDetachmentKind   CountTargetKind = "DetachmentKind"
	CountTargetKindAnyUnit          CountTargetKind = "AnyUnit"
)

type MovementKind string

const (
	MovementKindInches   MovementKind = "Inches"
	MovementKindRange    MovementKind = "Range"
	MovementKindImmobile MovementKind = "Immobile"
)

// CountTarget is a tagged union: Kind says which of the other fields is set.
type CountTarget struct {
	Kind       CountTargetKind `json:"kind"`
	Datasheet  *string         `json:"datasheet"`
	Keyword    string          `json:"keyword"`
	Option     string          `json:"option"`
	Detachment string          `json:"detachment"`
}

type Condition struct {
	Kind       ConditionKind `json:"kind"`
	Of         *CountTarget  `json:"of"`
	Minimum    *int          `json:"minimum"`
	Maximum    *int          `json:"maximum"`
	Faction    string        `json:"faction"`
	Conditions []Condition   `json:"conditions"`
	Condition  *Condition    `json:"condition"`
}

type LimitTerm struct {
	Per CountTarget `json:"per"`
}

type Limit struct {
	Base  int         `json:"base"`
	Terms []LimitTerm `json:"terms"`
}

// BoundedLimit is a slot or keyword limit: a fixed minimum and a growing maximum.
type BoundedLimit struct {
	Minimum *int   `json:"minimum"`
	Maximum *Limit `json:"maximum"`
}

type Movement struct {
	Kind    MovementKind `json:"kind"`
	Minimum int          `json:"minimum"`
	Maximum int          `json:"maximum"`
}

type ModelProfile struct {
	Name     string   `json:"name"`
	Movement Movement `json:"movement"`
}

type ProfileSet struct {
	Movement *Movement `json:"movement"`
}

type ProfileChange struct {
	Profile *string     `json:"profile"`
	Set     *ProfileSet `json:"set"`
}

type KeywordChanges struct {
	AddsFactionKeywords []string `json:"addsFactionKeywords"`
	AddsKeywords        []string `json:"addsKeywords"`
}

type Option struct {
	KeywordChanges
	ID             string          `json:"id"`
	Minimum        *int            `json:"minimum"`
	Maximum        *int            `json:"maximum"`
	AddsWeapons    []string        `json:"addsWeapons"`
	RemovesWeapons []string        `json:"removesWeapons"`
	AddsAbilities  []string        `json:"addsAbilities"`
	ProfileChanges []ProfileChange `json:"profileChanges"`
	AvailableWhen  *Condition      `json:"availableWhen"`
}

// UniversalOption takes its id from its key, so its own `id` is optional.
type UniversalOption struct {
	Option
	ID *string `json:"id"`
}

type OptionGroup struct {
	ID      string   `json:"id"`
	Minimum *int     `json:"minimum"`
	Maximum *int     `json:"maximum"`
	Default *string  `json:"default"`
	Options []Option `json:"options"`
}

type AlternativeRole struct {
	When Condition `json:"when"`
}

type Datasheet struct {
	FactionKeywords  []string          `json:"factionKeywords"`
	Keywords         []string          `json:"keywords"`
	Profiles         []ModelProfile    `json:"profiles"`
	Weapons          []string          `json:"weapons"`
	Abilities        []string          `json:"abilities"`
	Wargear          []OptionGroup     `json:"wargear"`
	AlternativeRoles []AlternativeRole `json:"alternativeRoles"`
	AvailableWhen    *Condition        `json:"availableWhen"`
}

type ConditionalKeywords struct {
	KeywordChanges
	When Condition `json:"when"`
}

type DatasheetLink struct {
	KeywordChanges
	Datasheet           string                `json:"datasheet"`
	AlternativeRoles    []AlternativeRole     `json:"alternativeRoles"`
	AddsAbilities       []string              `json:"addsAbilities"`
	ConditionalKeywords []ConditionalKeywords `json:"conditionalKeywords"`
	AvailableWhen       *Condition            `json:"availableWhen"`
}

type DetachmentChoice struct {
	Minimum *int                      `json:"minimum"`
	Maximum *int                      `json:"maximum"`
	Options map[string]KeywordChanges `json:"options"`
}

type DetachmentAbility struct {
	Ability       string     `json:"ability"`
	AvailableWhen *Condition `json:"availableWhen"`
}

// NamedEntry is a weapon, ability or warmaster trait: only its slug matters here.
type NamedEntry struct{}

type Catalogue struct {
	ID                  string                       `json:"id"`
	Kind                CatalogueKind                `json:"kind"`
	Imports             []string                     `json:"imports"`
	Datasheets          map[string]Datasheet         `json:"datasheets"`
	DatasheetLinks      map[string]DatasheetLink     `json:"datasheetLinks"`
	DetachmentChoices   map[string]DetachmentChoice  `json:"detachmentChoices"`
	DetachmentAbilities map[string]DetachmentAbility `json:"detachmentAbilities"`
	Weapons             map[string]NamedEntry        `json:"weapons"`
	Abilities           map[string]NamedEntry        `json:"abilities"`
	WarmasterTraits     map[string]NamedEntry        `json:"warmasterTraits"`
	fileName            string
}

type Detachment struct {
	MaximumPerArmy *Limit                  `json:"maximumPerArmy"`
	AvailableWhen  *Condition              `json:"availableWhen"`
	Slots          map[string]BoundedLimit `json:"slots"`
	KeywordLimits  map[string]BoundedLimit `json:"keywordLimits"`
	Abilities      []string                `json:"abilities"`
}

type GameSystem struct {
	Release           string                     `json:"release"`
	Detachments       map[string]Detachment      `json:"detachments"`
	UniversalOptions  map[string]UniversalOption `json:"universalOptions"`
	ArmyKeywordLimits map[string]BoundedLimit    `json:"armyKeywordLimits"`
	Abilities         map[string]NamedEntry      `json:"abilities"`
	WarmasterTraits   map[string]NamedEntry      `json:"warmasterTraits"`
}

type Dataset struct {
	GameSystem GameSystem
	Catalogues map[string]*Catalogue
}
