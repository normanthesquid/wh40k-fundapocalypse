package main

import "encoding/json"

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
	CountTargetKindOptionGroup      CountTargetKind = "OptionGroup"
	CountTargetKindDetachmentChoice CountTargetKind = "DetachmentChoice"
	CountTargetKindDetachment       CountTargetKind = "Detachment"
	CountTargetKindDetachmentKind   CountTargetKind = "DetachmentKind"
	CountTargetKindAnyUnit          CountTargetKind = "AnyUnit"
	CountTargetKindUniversalOption  CountTargetKind = "UniversalOption"
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
	Group      string          `json:"group"`
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

// Bound is an option group's minimum or maximum: a fixed number, or a limit that grows with the unit.
type Bound struct {
	Fixed   *int
	Growing *Limit
}

// UnmarshalJSON reads a number as fixed, including one written as 1.0, which JSON Schema counts as an integer.
func (bound *Bound) UnmarshalJSON(content []byte) error {
	var number float64
	if json.Unmarshal(content, &number) == nil {
		fixed := int(number)
		bound.Fixed = &fixed
		return nil
	}
	bound.Growing = &Limit{}
	return json.Unmarshal(content, bound.Growing)
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

// WargearChanges are what an option, or a datasheet's conditional change, adds and removes.
type WargearChanges struct {
	KeywordChanges
	AddsWeapons    []string        `json:"addsWeapons"`
	RemovesWeapons []string        `json:"removesWeapons"`
	AddsAbilities  []string        `json:"addsAbilities"`
	ProfileChanges []ProfileChange `json:"profileChanges"`
}

type CostChange struct {
	When Condition `json:"when"`
}

type Option struct {
	WargearChanges
	ID            string         `json:"id"`
	Minimum       *int           `json:"minimum"`
	Maximum       *Bound         `json:"maximum"`
	CostChanges   []CostChange   `json:"costChanges"`
	AddsProfiles  []ModelProfile `json:"addsProfiles"`
	AvailableWhen *Condition     `json:"availableWhen"`
	RequiredWhen  *Condition     `json:"requiredWhen"`
}

type ConditionalChange struct {
	WargearChanges
	When Condition `json:"when"`
}

// UniversalOption takes its id from its key, so its own `id` is optional.
type UniversalOption struct {
	Option
	ID *string `json:"id"`
}

type OptionGroup struct {
	ID            string     `json:"id"`
	Minimum       *Bound     `json:"minimum"`
	Maximum       *Bound     `json:"maximum"`
	MultipleOf    *int       `json:"multipleOf"`
	AvailableWhen *Condition `json:"availableWhen"`
	Default       *string    `json:"default"`
	Options       []Option   `json:"options"`
}

type AlternativeRole struct {
	When Condition `json:"when"`
}

type Datasheet struct {
	FactionKeywords      []string            `json:"factionKeywords"`
	Keywords             []string            `json:"keywords"`
	Profiles             []ModelProfile      `json:"profiles"`
	Weapons              []string            `json:"weapons"`
	Abilities            []string            `json:"abilities"`
	Wargear              []OptionGroup       `json:"wargear"`
	ConditionalChanges   []ConditionalChange `json:"conditionalChanges"`
	CostChanges          []CostChange        `json:"costChanges"`
	AlternativeRoles     []AlternativeRole   `json:"alternativeRoles"`
	AvailableWhen        *Condition          `json:"availableWhen"`
	RequiredInDetachment *DetachmentMinimum  `json:"requiredInDetachment"`
	MaximumPerDetachment *int                `json:"maximumPerDetachment"`
}

type DetachmentMinimum struct {
	Minimum int       `json:"minimum"`
	When    Condition `json:"when"`
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
	UnitsShareFaction bool                    `json:"unitsShareFaction"`
	MaximumPerArmy    *Limit                  `json:"maximumPerArmy"`
	AvailableWhen     *Condition              `json:"availableWhen"`
	Slots             map[string]BoundedLimit `json:"slots"`
	KeywordLimits     map[string]BoundedLimit `json:"keywordLimits"`
	Abilities         []string                `json:"abilities"`
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
