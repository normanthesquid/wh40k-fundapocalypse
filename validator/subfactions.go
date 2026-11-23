package main

import (
	"slices"
	"strings"
)

// checkSubfactions is rule 10: each placeholder a faction's units carry has exactly one subfaction choice,
// which names a keyword for each of its options.
func (check *checker) checkSubfactions(where scope, catalogue *Catalogue) {
	carried, complete := check.carriedPlaceholders(where, catalogue)
	fillers := map[string][]string{}
	optionKeywords := map[string]string{}
	for _, slug := range sortedKeys(catalogue.DetachmentChoices) {
		choice := catalogue.DetachmentChoices[slug]
		choiceScope := where.at("detachmentChoices/%s", slug)
		if choice.FillsPlaceholder == nil {
			check.checkPlainChoice(choiceScope, choice)
			continue
		}
		placeholder := *choice.FillsPlaceholder
		fillers[placeholder] = append(fillers[placeholder], slug)
		// A link that doesn't resolve is reported already, and may be what carries the placeholder.
		if complete && !carried[placeholder] {
			check.report(choiceScope, "no unit of this faction carries %q", placeholder)
		}
		for _, optionSlug := range sortedKeys(choice.Options) {
			keyword := choice.Options[optionSlug].Keyword
			optionScope := choiceScope.at("options/%s", optionSlug)
			if keyword == nil {
				check.report(optionScope, "a subfaction choice's option names its keyword")
				continue
			}
			if other, taken := optionKeywords[*keyword]; taken {
				check.report(optionScope, "keyword %q is already option %q's", *keyword, other)
			}
			optionKeywords[*keyword] = optionSlug
		}
	}
	for _, placeholder := range sortedKeys(carried) {
		switch choices := fillers[placeholder]; len(choices) {
		case 0:
			check.report(where, "no detachment choice fills %q", placeholder)
		case 1:
		default:
			check.report(where, "%q is filled by more than one detachment choice: %s", placeholder, strings.Join(choices, ", "))
		}
	}
}

// checkPlainChoice covers a choice that fills no placeholder: it has options, and none names a keyword.
func (check *checker) checkPlainChoice(where scope, choice DetachmentChoice) {
	if len(choice.Options) == 0 {
		check.report(where, "only a subfaction choice may have no options")
	}
	for _, optionSlug := range sortedKeys(choice.Options) {
		if choice.Options[optionSlug].Keyword != nil {
			check.report(where.at("options/%s", optionSlug), "only a subfaction choice's option names a keyword")
		}
	}
}

// carriedPlaceholders are the placeholder faction keywords the faction's own units and links carry,
// and whether every link resolved.
func (check *checker) carriedPlaceholders(where scope, catalogue *Catalogue) (map[string]bool, bool) {
	var keywords []string
	for _, datasheet := range catalogue.Datasheets {
		keywords = append(keywords, datasheet.FactionKeywords...)
	}
	silent := &checker{dataset: check.dataset}
	complete := true
	for _, link := range catalogue.DatasheetLinks {
		keywords = append(keywords, link.AddsFactionKeywords...)
		target := silent.linkedDatasheet(where, link)
		if target == nil {
			complete = false
			continue
		}
		keywords = append(keywords, target.FactionKeywords...)
	}
	placeholders := map[string]bool{}
	for _, keyword := range slices.Compact(keywords) {
		if isPlaceholder(keyword) {
			placeholders[keyword] = true
		}
	}
	return placeholders, complete
}

func isPlaceholder(keyword string) bool {
	return strings.HasPrefix(keyword, "<") && strings.HasSuffix(keyword, ">")
}
